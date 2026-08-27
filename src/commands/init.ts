import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BRIDGE_AGENTS } from '../bridge/types.js';
import { defaultConfig, loadConfig, saveConfig } from '../lib/config.js';
import { applyAudit, applyBackend, auditConfig, auditMemoryRepo } from '../lib/config-doctor.js';
import { findOnPath } from '../lib/detect.js';
import { countScribeSlices, purgeDerivedSlices } from '../lib/ingest.js';
import { ensureMemoryRepo } from '../lib/memory-repo.js';
import { defaultMemoryRepo, resolvePaths, type PreviouslyPaths } from '../lib/paths.js';
import { createPromptIO, type PromptIO } from '../lib/prompt.js';
import {
  banner,
  bold,
  cmd,
  cmdTable,
  emph,
  err,
  gray,
  green,
  heading,
  info,
  muted,
  ok,
  printBoxed,
  red,
  section,
  warn,
} from '../lib/ansi.js';
import { SCRIBE_SOURCES, type ScribeRoots, type ScribeSource } from '../scribe/types.js';
import { resolveScribeRoots } from '../scribe/watcher.js';
import { run as cardRun } from './card.js';
import { run as ingestRun } from './ingest.js';
import { createEngine } from './scribe.js';

/**
 * `previously init` — first-run setup, THE onboarding command. It does the
 * whole job in one go:
 *
 *   1. Create the ~/.previously layout and write a minimal config.json
 *      (skipped when already initialized, unless --force). The memory root
 *      (default: the platform-conventional repo location from
 *      defaultMemoryRepo()) is a local git repository — created here, or
 *      adopted when one already exists (e.g. cloned back from GitHub);
 *      foreign non-empty directories are refused, never initialized over.
 *   2. HISTORY IMPORT: scan every detected agent CLI's session logs and
 *      transcribe them into Previously time slices (the scribe pipeline,
 *      pure local processing — no model calls, no token cost). This step is
 *      incremental and byte-level idempotent, so re-running init is safe and
 *      only picks up what's new.
 *
 * Two shapes, one flow:
 *
 *   - WIZARD (TTY, default): a human gets asked — memory location, backend,
 *     whether to import history, keep-or-rebuild existing slices, and the
 *     optional token-spending steps (estimate shown before anything spends).
 *   - NON-INTERACTIVE (--non-interactive, --json, or no TTY): never prompts;
 *     flags and defaults decide everything and every decision is printed.
 *     This is the shape scripts, CI, and agent CLIs use.
 *
 * When content already exists, init says so and points at the escape hatch:
 *   --rebuild         delete all scribe-derived slices and re-transcribe from
 *                     the raw logs (e.g. after a transcription-format upgrade).
 *                     With --include-custom, externally submitted (ingest
 *                     --submit) slices are also dropped. Kernel conversations
 *                     (Previously's own chats) are NEVER touched.
 *   --skip-ingest     layout/config only, no history import (scripts/CI).
 *
 * All styling comes from lib/ansi.ts and is inert off-TTY, so --json and
 * scripted output stay byte-stable.
 */

const BACKEND_CHOICES = [...BRIDGE_AGENTS, 'api-key', 'none'] as const;
type BackendChoice = (typeof BACKEND_CHOICES)[number];

function normalizeBackend(value: string): BackendChoice | null {
  const v = value.trim().toLowerCase();
  return (BACKEND_CHOICES as readonly string[]).includes(v) ? (v as BackendChoice) : null;
}

function ensureLayout(paths: PreviouslyPaths): void {
  for (const dir of [
    paths.home,
    paths.memoryDir,
    paths.kernelDir,
    paths.kernelVersionsDir,
    paths.logsDir,
    paths.skillsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Which subscription bridge CLIs are on PATH, in display order. */
function detectBackends(): { agent: string; found: boolean }[] {
  return BRIDGE_AGENTS.map((agent) => ({ agent, found: findOnPath(agent) !== null }));
}

interface SourceDetection {
  source: ScribeSource;
  root: string;
  present: boolean;
}

function detectSources(roots: ScribeRoots): SourceDetection[] {
  return SCRIBE_SOURCES.map((source) => ({ source, root: roots[source], present: existsSync(roots[source]) }));
}

interface SourceImportStat {
  rootPresent: boolean;
  filesProcessed: number;
  events: number;
  parseErrors: number;
}

interface ImportResult {
  perSource: Record<ScribeSource, SourceImportStat>;
  errors: string[];
}

/** Purge scribe-derived slices + scribe state; returns how many were removed. */
function runRebuild(paths: PreviouslyPaths, memoryRoot: string, includeCustom: boolean): number {
  const { removedIds } = purgeDerivedSlices(memoryRoot, includeCustom);
  // Scribe state (cursors / per-session state / status) is derived data —
  // wiping it forces a from-byte-0 re-read of every raw log.
  rmSync(paths.scribeCursorsPath, { force: true });
  rmSync(paths.scribeSessionsDir, { recursive: true, force: true });
  rmSync(paths.scribeStatusPath, { force: true });
  console.log(
    `${bold('Rebuild:')} removed ${removedIds.length} transcribed slice(s)` +
      `${includeCustom ? ' (including submitted custom content)' : ''}` +
      ' — kernel conversations were left untouched.',
  );
  return removedIds.length;
}

/** Full history import via the scribe engine, with per-source reporting. */
async function runImport(paths: PreviouslyPaths, roots?: ScribeRoots): Promise<ImportResult> {
  const engine = createEngine(paths, roots);
  const summary = await engine.scanOnce();
  const perSource = {} as Record<ScribeSource, SourceImportStat>;
  for (const source of SCRIBE_SOURCES) {
    const s = summary.sources[source];
    perSource[source] = {
      rootPresent: s.rootPresent,
      filesProcessed: s.filesProcessed,
      events: s.events,
      parseErrors: s.parseErrors,
    };
    if (!s.rootPresent) {
      console.log(`  ${bold(source)}: ${muted('no log directory found — skipped')}`);
    } else {
      const parseErrors = s.parseErrors > 0 ? red(String(s.parseErrors)) : String(s.parseErrors);
      console.log(`  ${bold(source)}: ${s.filesProcessed} log file(s) transcribed (${s.events} events, ${parseErrors} parse errors)`);
    }
  }
  for (const e of summary.errors) {
    console.error(err(`  error: ${e.file}: ${e.message}`));
  }
  return { perSource, errors: summary.errors.map((e) => `${e.file}: ${e.message}`) };
}

function printNextSteps(): void {
  console.log('');
  console.log(section('Next steps:'));
  for (const line of cmdTable([
    ['previously start', 'start the kernel + scribe'],
    ['previously open', 'open the Web UI'],
    ['previously install --all', 'give your agent CLIs the Previously skill group'],
    ['previously', 'show the status dashboard'],
  ])) {
    console.log(line);
  }
}

/**
 * Create/adopt the memory git repository at memoryRoot and report the outcome.
 * Previously content stranded without a .git (pre-git-upgrade data) is first
 * repaired in place via the doctor's memory audit. Returns false (after
 * printing the reason + an actionable hint) when the directory cannot become
 * the memory repo — init must not proceed then.
 */
async function ensureRepoStep(memoryRoot: string): Promise<boolean> {
  const audit = await auditMemoryRepo(memoryRoot);
  for (const repair of audit.repairs) console.log(`  ${green('repaired:')} ${repair}`);
  const result = await ensureMemoryRepo(memoryRoot);
  if (!result.ok) {
    console.error(err(result.reason));
    console.error(`Fix the directory, or re-run with ${cmd('previously init --memory-root <path>')} pointing elsewhere.`);
    return false;
  }
  // When the doctor just repaired the repo into existence, its repair line
  // already told the story — don't repeat it as an init/adopt note. (The
  // doctor's audit runs ensureMemoryRepo itself, so a successful audit means
  // `result` is `adopted` here; `created` is unreachable in this flow.)
  if (audit.repairs.length > 0) return true;
  if (result.adopted) {
    console.log(info(`Adopted the existing Previously memory repository at ${emph(memoryRoot)} — its history is kept as-is.`));
  }
  return true;
}

export interface InitOptions {
  /** Test hook: override the per-agent log roots for the history import. */
  roots?: ScribeRoots;
  /** Test hook: force the interactive/non-interactive decision. */
  isTTY?: boolean;
  /** Test hook: scripted answers for the wizard. */
  promptIO?: PromptIO;
}

export async function run(args: string[], opts: InitOptions = {}): Promise<number> {
  const { values } = parseInitArgs(args);

  const paths = resolvePaths();

  let backend: string | null = null;
  const backendProvided = values.backend !== undefined;
  if (backendProvided) {
    const choice = normalizeBackend(values.backend!);
    if (choice === null) {
      console.error(err(`Unknown --backend value: ${values.backend} (expected ${BACKEND_CHOICES.join('|')})`));
      return 1;
    }
    backend = choice === 'none' ? null : choice;
  }
  if (values['memory-root'] !== undefined && values['memory-root'].trim() === '') {
    console.error(err('--memory-root must be a non-empty path.'));
    return 1;
  }

  const tty = opts.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  const interactive = !values['non-interactive'] && !values.json && tty;
  if (interactive) return runWizard(paths, values, backend, backendProvided, opts);
  return runNonInteractive(paths, values, backend, backendProvided, opts);
}

type ParsedValues = ReturnType<typeof parseInitArgs>['values'];
function parseInitArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      backend: { type: 'string' },
      rebuild: { type: 'boolean', default: false },
      'include-custom': { type: 'boolean', default: false },
      'skip-ingest': { type: 'boolean', default: false },
      'non-interactive': { type: 'boolean', default: false },
      'memory-root': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
}

/** Non-interactive flow: flags + defaults decide everything, no prompts. */
async function runNonInteractive(
  paths: PreviouslyPaths,
  values: ParsedValues,
  backend: string | null,
  backendProvided: boolean,
  opts: InitOptions,
): Promise<number> {
  ensureLayout(paths);

  const alreadyInitialized = existsSync(paths.configPath);
  const configFlagsGiven = backendProvided || values['memory-root'] !== undefined;
  if (alreadyInitialized && !values.force) {
    if (configFlagsGiven) {
      const config = loadConfig(paths);
      if (backendProvided) applyBackend(config, backend);
      if (values['memory-root'] !== undefined) config.memoryRoot = values['memory-root'];
      saveConfig(config, paths);
      console.log(info(`Previously is already initialized at ${paths.home} — config updated (use --force to start over).`));
    } else {
      console.log(info(`Previously is already initialized at ${paths.home} — existing config kept (use --force to overwrite).`));
    }
  } else {
    if (alreadyInitialized) {
      // --force: back up the existing config once before wiping it — apiKeys
      // and agents tuning are user assets, not disposable state.
      const backupPath = `${paths.configPath}.bak`;
      if (!existsSync(backupPath)) {
        copyFileSync(paths.configPath, backupPath);
        console.log(info(`Existing config backed up to ${emph(backupPath)}.`));
      }
    }
    const config = defaultConfig(paths);
    applyBackend(config, backend);
    // The default memory root is the platform-conventional repo location
    // (Documents/Previously), overridable with --memory-root.
    config.memoryRoot = values['memory-root'] ?? defaultMemoryRepo();
    saveConfig(config, paths);
    console.log(ok(`Initialized Previously home at ${emph(paths.home)}`));
    console.log(`  ${bold('memory/')}          local time-slice storage`);
    console.log(`  ${bold('kernel/versions/')} installed kernel versions (see ${cmd('`previously kernel install`')})`);
    console.log(`  ${bold('logs/')}            kernel logs`);
    console.log(
      `  ${bold('config.json')}      written (execution backend: ${config.executionBackend ?? '(unset)'}` +
        `${config.brain?.type === 'bridge' ? `, brain: bridge:${config.brain.agent}` : ''}` +
        `, memory root: ${config.memoryRoot})`,
    );
  }

  // Config doctor: every init run audits the config and repairs what's
  // broken (missing brain for a bridge backend, illegal values, …).
  const audit = auditConfig(paths);
  if (audit.repairs.length > 0) {
    for (const repair of audit.repairs) console.log(`  ${green('repaired:')} ${repair}`);
    applyAudit(paths, audit);
  }

  const memoryRoot = loadConfig(paths).memoryRoot;

  // The memory root is a git repository: create it, or adopt an existing one
  // (e.g. cloned back from GitHub). Refuses to init over foreign data.
  if (!(await ensureRepoStep(memoryRoot))) return 1;

  let removed = 0;
  if (values.rebuild) {
    removed = runRebuild(paths, memoryRoot, values['include-custom']);
  }

  if (values['skip-ingest']) {
    if (values.json) {
      console.log(JSON.stringify({ home: paths.home, memoryRoot, backend, rebuilt: removed, imported: null, errors: [] }));
    }
    return 0;
  }

  // History import — the big step. Idempotent and incremental without
  // --rebuild: existing slices are only re-rendered when the bytes differ.
  const existing = countScribeSlices(memoryRoot);
  if (!values.rebuild && existing > 0) {
    console.log(
      info(
        `Memory already holds ${existing} transcribed slice(s); new content is picked up incrementally. ` +
          'To discard and re-transcribe them from the raw logs, re-run with --rebuild.',
      ),
    );
  }
  const result = await runImport(paths, opts.roots);

  printNextSteps();
  if (values.json) {
    console.log(
      JSON.stringify({
        home: paths.home,
        memoryRoot,
        backend: loadConfig(paths).executionBackend,
        rebuilt: removed,
        imported: result.perSource,
        errors: result.errors,
        nextSteps: ['previously start', 'previously open', 'previously install --all'],
      }),
    );
  }
  return result.errors.length > 0 ? 1 : 0;
}

/** Wizard flow: a human on a TTY gets asked, with defaults everywhere. */
async function runWizard(
  paths: PreviouslyPaths,
  values: ParsedValues,
  backend: string | null,
  backendProvided: boolean,
  opts: InitOptions,
): Promise<number> {
  const io = opts.promptIO ?? createPromptIO();
  const skipped: string[] = [];
  try {
    const bannerLines = banner('Previously', 'local long-term memory for your agents.');
    const welcomeBody = [
      'This wizard sets up the home layout and config, then can transcribe',
      'your existing agent history into time slices (pure local processing).',
      muted('Steps that spend subscription tokens are opt-in and estimated first.'),
    ];
    if (bannerLines.length > 0) {
      for (const line of bannerLines) console.log(line);
      console.log('');
      for (const line of welcomeBody) console.log(line);
    } else {
      printBoxed([heading('Previously — local long-term memory for your agents.'), ...welcomeBody]);
    }
    console.log('');

    ensureLayout(paths);
    const alreadyInitialized = existsSync(paths.configPath);
    if (alreadyInitialized && !values.force) {
      console.log(info(`Existing config found at ${paths.configPath} — keeping it (re-run with --force to reconfigure).`));
      // Config doctor: surface problems and offer to repair them.
      const audit = auditConfig(paths);
      if (audit.repairs.length > 0) {
        console.log(warn('Your config has issues:'));
        for (const repair of audit.repairs) console.log(`  - ${repair}`);
        if (await io.confirm('Repair these now? (a config.json.bak backup is kept)', true)) {
          applyAudit(paths, audit);
          console.log(ok('Config repaired.'));
        } else {
          skipped.push('config repairs (declined — `previously init --non-interactive` repairs automatically)');
        }
      }
    } else {
      const config = defaultConfig(paths);

      const memoryAnswer = await io.ask(
        'Where should Previously store your memory (time slices)? It becomes a local git repository — you can push it to a private GitHub repo later.',
        values['memory-root'] ?? defaultMemoryRepo(),
      );
      config.memoryRoot = memoryAnswer;

      const detected = detectBackends();
      const found = detected.filter((d) => d.found).map((d) => d.agent);
      console.log(
        found.length > 0
          ? `Detected agent CLIs on PATH: ${green(found.join(', '))}`
          : muted('No agent CLI detected on PATH (claude/codex/kimi).'),
      );
      const defaultBackend = backendProvided ? (backend ?? 'none') : (found[0] ?? 'none');
      let choice: BackendChoice | null = null;
      while (choice === null) {
        const answer = await io.ask(`Execution backend (${BACKEND_CHOICES.join('/')})`, defaultBackend);
        choice = normalizeBackend(answer);
        if (choice === null) console.log(err(`Unknown backend "${answer}" — expected ${BACKEND_CHOICES.join('|')}.`));
      }
      applyBackend(config, choice === 'none' ? null : choice);

      saveConfig(config, paths);
      console.log(ok(`Config written to ${emph(paths.configPath)}`));
      console.log(`  ${bold('memory root:')}      ${emph(config.memoryRoot)}`);
      console.log(`  ${bold('execution backend:')} ${config.executionBackend ?? '(unset)'}`);
      if (config.brain?.type === 'bridge') console.log(`  ${bold('brain:')}            bridge:${config.brain.agent} (subscription — no API key needed)`);
    }

    const memoryRoot = loadConfig(paths).memoryRoot;

    // The memory root is a git repository: create it, or adopt an existing
    // one (e.g. cloned back from GitHub). Refuses to init over foreign data.
    if (!(await ensureRepoStep(memoryRoot))) return 1;

    // Existing content: keep-and-increment (default) or rebuild.
    let rebuild = values.rebuild;
    const existing = countScribeSlices(memoryRoot);
    if (existing > 0 && !rebuild) {
      const keep = await io.confirm(
        `Memory already holds ${existing} transcribed slice(s). Keep them and import only what's new?`,
        true,
      );
      rebuild = !keep;
    }
    let includeCustom = values['include-custom'];
    if (rebuild && !includeCustom) {
      includeCustom = await io.confirm(
        'Also discard externally submitted custom slices? (Kernel conversations are never touched.)',
        false,
      );
    }
    if (rebuild) runRebuild(paths, memoryRoot, includeCustom);

    // History import.
    let importErrors = 0;
    if (values['skip-ingest']) {
      skipped.push('history import (--skip-ingest)');
    } else {
      const roots = opts.roots ?? resolveScribeRoots();
      const sources = detectSources(roots);
      console.log('');
      console.log(section('Agent history on this machine:'));
      printBoxed(
        sources.map(
          (s) => `  ${bold(s.source)}: ${s.present ? green(`logs found (${s.root})`) : muted('no logs found')}`,
        ),
      );
      if (!sources.some((s) => s.present)) {
        console.log(muted('Nothing to import yet — the scribe picks up new sessions automatically once started.'));
      } else if (
        await io.confirm('Transcribe this history into time slices now? (pure local processing, no token cost)', true)
      ) {
        console.log(info('Importing history…'));
        const result = await runImport(paths, roots);
        importErrors = result.errors.length;
      } else {
        skipped.push('history import (run `previously ingest --source <agent>` anytime)');
      }
    }

    // Optional token-spending steps: estimate first, default no.
    const config = loadConfig(paths);
    const brain = config.executionBackend;
    const brainUsable =
      brain !== null && (BRIDGE_AGENTS as readonly string[]).includes(brain) && findOnPath(brain) !== null;
    const hasSlices = countScribeSlices(memoryRoot) > 0;
    console.log('');
    if (!brainUsable) {
      console.log(muted('No usable bridge backend configured — skipping the optional token-spending steps.'));
      console.log(muted('(You can run `previously ingest --mark` / `previously card bootstrap` later once a backend is set.)'));
    } else if (!hasSlices) {
      console.log(muted('No slices in memory yet — skipping the optional token-spending steps.'));
    } else {
      if (
        await io.confirm(
          'OPTIONAL (spends tokens): fill focus/summary/tags (线索) for imported slices now?',
          false,
        )
      ) {
        await ingestRun(['--mark']); // prints the estimate, spends nothing
        if (await io.confirm('Proceed with this batch?', false)) {
          await ingestRun(['--mark', '--yes']);
        } else {
          skipped.push('semantic marking (declined at the estimate)');
        }
      } else {
        skipped.push('semantic marking (the kernel backfills focus/summary lazily; only tags stay empty)');
      }
      if (await io.confirm('OPTIONAL (spends tokens): bootstrap the 前情提要 card from the last 7 days now?', false)) {
        await cardRun(['bootstrap']); // prints the estimate, spends nothing
        if (await io.confirm('Proceed with this call?', false)) {
          await cardRun(['bootstrap', '--yes']);
        } else {
          skipped.push('card bootstrap (declined at the estimate)');
        }
      } else {
        skipped.push('card bootstrap (run `previously card bootstrap` anytime)');
      }
    }

    console.log('');
    printBoxed([ok(bold('All done.'))], { tone: 'green', pad: true });
    printNextSteps();
    if (skipped.length > 0) {
      console.log(bold('Skipped:'));
      for (const s of skipped) console.log(gray(`  - ${s}`));
    }
    return importErrors > 0 ? 1 : 0;
  } finally {
    io.close();
  }
}
