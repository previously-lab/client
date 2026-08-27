import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as init } from '../src/commands/init.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { admitSlice, countScribeSlices, type SubmittedSlice } from '../src/lib/ingest.js';
import { commitAll, ensureMemoryRepo, repoSummary } from '../src/lib/memory-repo.js';
import { resolvePaths } from '../src/lib/paths.js';
import type { PromptIO } from '../src/lib/prompt.js';
import type { ScribeRoots } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import {
  claudeAssistantLine,
  claudeMetaLines,
  claudeUserLine,
  codexMessageLine,
  codexSessionMetaLine,
  makeFakeAgentHome,
  writeClaudeSession,
  writeCodexSession,
} from './scribe-fixtures.js';

describe('init', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  /** Roots pointing nowhere — keeps init's history import a fast no-op. */
  const emptyRoots = (base: string): ScribeRoots => ({
    'claude-code': join(base, 'no-logs', 'claude'),
    codex: join(base, 'no-logs', 'codex'),
    'kimi-code': join(base, 'no-logs', 'kimi'),
    gemini: join(base, 'no-logs', 'gemini'),
  });

  it('creates the directory layout and default config', async () => {
    home = useTempHome();
    expect(await init([], { roots: emptyRoots(home) })).toBe(0);
    const paths = resolvePaths();
    for (const dir of [paths.home, paths.memoryDir, paths.kernelDir, paths.logsDir, paths.skillsDir]) {
      expect(existsSync(dir), dir).toBe(true);
    }
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config).toMatchObject({
      storage: 'local',
      memoryRoot: join(home, 'memory'),
      port: 3210,
      hostname: '127.0.0.1',
      executionBackend: null,
    });
  });

  it('is idempotent: a second run keeps an existing config untouched', async () => {
    home = useTempHome();
    expect(await init([], { roots: emptyRoots(home) })).toBe(0);
    const paths = resolvePaths();
    // User edits the config afterwards.
    const edited = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    edited.port = 9999;
    edited.customField = 'keep-me';
    writeFileSync(paths.configPath, JSON.stringify(edited), 'utf8');

    expect(await init([], { roots: emptyRoots(home) })).toBe(0);
    const after = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(after.port).toBe(9999);
    expect(after.customField).toBe('keep-me');
  });

  it('--force overwrites an existing config with defaults', async () => {
    home = useTempHome();
    expect(await init([], { roots: emptyRoots(home) })).toBe(0);
    const paths = resolvePaths();
    writeFileSync(paths.configPath, JSON.stringify({ port: 9999 }), 'utf8');

    expect(await init(['--force'], { roots: emptyRoots(home) })).toBe(0);
    const after = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(after.port).toBe(3210);
  });

  it('--force backs up the existing config (apiKeys, tuning) before wiping it', async () => {
    home = useTempHome();
    expect(await init([], { roots: emptyRoots(home) })).toBe(0);
    const paths = resolvePaths();
    const original = { port: 9999, apiKeys: { DEEPSEEK_API_KEY: 'sk-user-tuned' } };
    writeFileSync(paths.configPath, JSON.stringify(original), 'utf8');

    expect(await init(['--force'], { roots: emptyRoots(home) })).toBe(0);
    const backup = JSON.parse(readFileSync(`${paths.configPath}.bak`, 'utf8'));
    expect(backup.apiKeys).toEqual(original.apiKeys);
    expect(backup.port).toBe(9999);
    const after = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(after.apiKeys).toBeUndefined();
  });

  it('--backend sets executionBackend non-interactively', async () => {
    home = useTempHome();
    expect(await init(['--backend', 'claude'], { roots: emptyRoots(home) })).toBe(0);
    const config = JSON.parse(readFileSync(resolvePaths().configPath, 'utf8'));
    expect(config.executionBackend).toBe('claude');
    // A bridge backend implies the bridge brain (subscription mode).
    expect(config.brain).toEqual({ type: 'bridge', agent: 'claude' });
  });

  it('--backend none stores an explicit unset', async () => {
    home = useTempHome();
    expect(await init(['--backend', 'none'], { roots: emptyRoots(home) })).toBe(0);
    const config = JSON.parse(readFileSync(resolvePaths().configPath, 'utf8'));
    expect(config.executionBackend).toBeNull();
  });

  it('--backend rejects unknown values without writing a config', async () => {
    home = useTempHome();
    expect(await init(['--backend', 'gemini'])).toBe(1);
    expect(existsSync(resolvePaths().configPath)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Shared fixtures for the import / rebuild / wizard suites below.     */
/* ------------------------------------------------------------------ */

/**
 * One claude-code session (slice 2026-08-10-1401, 2 events) and one codex
 * session (slice 2026-08-10-1530, 2 events) under fake agent roots inside the
 * temp home. Slice ids derive from UTC timestamps, so they are
 * machine-timezone-independent.
 */
function writeFixtureLogs(home: string): ScribeRoots {
  const roots = makeFakeAgentHome(join(home, 'fakehome'));
  writeClaudeSession(roots, 'sess-a', [
    ...claudeMetaLines('sess-a'),
    claudeUserLine('帮我整理项目结构', '2026-08-10T14:01:00.000Z', 'sess-a'),
    claudeAssistantLine([{ kind: 'text', text: '好的，我先看一下。' }], '2026-08-10T14:01:05.000Z', 'sess-a'),
  ]);
  writeCodexSession(roots, 'rollout-1', [
    codexSessionMetaLine('rollout-1', '2026-08-10T15:30:00.000Z'),
    codexMessageLine('user', '写一个 hello world', '2026-08-10T15:30:02.000Z'),
    codexMessageLine('assistant', '写好了。', '2026-08-10T15:30:09.000Z'),
  ]);
  return roots;
}

function sliceCorePath(memoryRoot: string, sliceId: string): string {
  const [y, m, d, hm] = sliceId.split('-');
  return join(memoryRoot, 'episodic', 'slices', y!, m!, d!, hm!, 'timeline', 'core.md');
}

/** A valid externally-submitted (custom) slice, admitted via the write path. */
function makeSubmittedSlice(sliceId: string, start: string, end: string, source: string, sessionId: string): SubmittedSlice {
  return {
    sliceId,
    start,
    end,
    timezone: null,
    source,
    sessionId,
    focus: '',
    summary: '',
    tags: [],
    emotionalTone: null,
    turns: [
      { id: 't1', timestamp: start, role: 'user', body: '外部提交的内容' },
      { id: 't2', timestamp: end, role: 'agent', body: '收到。' },
    ],
  };
}

/**
 * Plant a "kernel slice" — a Previously conversation record. Its monthly
 * _index.json entry carries NO source label (source: ''), which is exactly
 * what marks it as a primary record that --rebuild must never touch. Placed
 * in 2026-08, the same month the fixture logs transcribe into.
 */
function seedKernelSlice(memoryRoot: string): void {
  const dir = join(memoryRoot, 'episodic', 'slices', '2026', '08', '12', '0900', 'timeline');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'core.md'),
    [
      '---',
      'slice_id: 2026-08-12-0900',
      'status: closed',
      "start: '2026-08-12T09:00:00.000Z'",
      "end: '2026-08-12T09:05:00.000Z'",
      '---',
      '',
      '## Turn k1 — 2026-08-12T09:00:00.000Z (user)',
      '',
      '内核自己的对话，谁也不许动。',
      '',
    ].join('\n'),
    'utf8',
  );
  const indexPath = join(memoryRoot, 'episodic', 'slices', '2026', '08', '_index.json');
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { month: string; slices: unknown[] };
  parsed.slices.push({
    id: '2026-08-12-0900',
    focus: '',
    summary: '',
    tags: [],
    status: 'closed',
    start: '2026-08-12T09:00:00.000Z',
    open_loops: [],
    decisions: [],
    source: '',
    sessionId: '',
  });
  writeFileSync(indexPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
}

/** Console capture shared by the suites below. */
let stdout: string[];
let stderr: string[];

function captureConsole(): void {
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
}

describe('init non-interactive history import', () => {
  let home: string;
  let roots: ScribeRoots;
  beforeEach(() => {
    home = useTempHome();
    roots = writeFixtureLogs(home);
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('one-shot: transcribes fixture logs per source, and a rerun is idempotent', async () => {
    const memoryRoot = join(home, 'memory');
    expect(await init([], { roots })).toBe(0);
    expect(countScribeSlices(memoryRoot)).toBe(2);
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-10-1401'))).toBe(true);
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-10-1530'))).toBe(true);
    const out = stdout.join('\n');
    expect(out).toContain('claude-code: 1 log file(s) transcribed');
    expect(out).toContain('codex: 1 log file(s) transcribed');
    expect(out).toContain('Next steps:');

    // Rerun: config kept, slices unchanged, incremental note printed.
    expect(await init([], { roots })).toBe(0);
    expect(countScribeSlices(memoryRoot)).toBe(2);
    const rerun = stdout.slice(out.split('\n').length).join('\n');
    expect(rerun).toContain('already initialized');
    expect(rerun).toContain('2 transcribed slice(s); new content is picked up incrementally');
  });

  it('--memory-root writes the custom path into config.json and lands slices there', async () => {
    const custom = join(home, 'elsewhere');
    expect(await init(['--memory-root', custom], { roots })).toBe(0);
    const config = JSON.parse(readFileSync(resolvePaths().configPath, 'utf8'));
    expect(config.memoryRoot).toBe(custom);
    expect(countScribeSlices(custom)).toBe(2);
    expect(existsSync(sliceCorePath(custom, '2026-08-10-1401'))).toBe(true);
    // Nothing leaks into the default memory dir.
    expect(existsSync(join(home, 'memory', 'episodic'))).toBe(false);
  });

  it('regression: --rebuild honors a pre-existing config with a custom memoryRoot', async () => {
    const custom = join(home, 'elsewhere');
    // Hand-written config pointing at a custom memory root (the bug was that
    // rebuild/purge acted on the default paths.memoryDir instead).
    saveConfig({ ...defaultConfig(resolvePaths()), memoryRoot: custom }, resolvePaths());
    // An old transcribed slice already living in the custom root.
    admitSlice(
      custom,
      makeSubmittedSlice('2026-08-09-0800', '2026-08-09T08:00:00.000Z', '2026-08-09T08:05:00.000Z', 'claude-code', 'old-1'),
      'UTC',
    );

    expect(await init(['--rebuild'], { roots })).toBe(0);
    // Purge acted on the CUSTOM root: the old slice is gone...
    expect(existsSync(sliceCorePath(custom, '2026-08-09-0800'))).toBe(false);
    expect(stdout.join('\n')).toContain('Rebuild: removed 1 transcribed slice(s)');
    // ...and the re-import landed there too, not in the default memory dir.
    expect(countScribeSlices(custom)).toBe(2);
    expect(existsSync(sliceCorePath(custom, '2026-08-10-1401'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'episodic'))).toBe(false);
  });

  it('--rebuild re-derives scribe slices, keeps kernel slices, keeps custom slices', async () => {
    const memoryRoot = join(home, 'memory');
    expect(await init([], { roots })).toBe(0);
    seedKernelSlice(memoryRoot);
    admitSlice(
      memoryRoot,
      makeSubmittedSlice('2026-08-11-1000', '2026-08-11T10:00:00.000Z', '2026-08-11T10:05:00.000Z', 'custom-agent', 'ext-1'),
      'UTC',
    );

    expect(await init(['--rebuild'], { roots })).toBe(0);
    expect(stdout.join('\n')).toContain('Rebuild: removed 2 transcribed slice(s)');
    // Scribe slices were deleted and re-derived from the raw logs.
    expect(countScribeSlices(memoryRoot)).toBe(2);
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-10-1401'))).toBe(true);
    // The kernel slice survived — bytes and manifest entry.
    expect(readFileSync(sliceCorePath(memoryRoot, '2026-08-12-0900'), 'utf8')).toContain('内核自己的对话');
    const index = JSON.parse(
      readFileSync(join(memoryRoot, 'episodic', 'slices', '2026', '08', '_index.json'), 'utf8'),
    ) as { slices: { id: string }[] };
    expect(index.slices.map((s) => s.id)).toContain('2026-08-12-0900');
    // Custom (submitted) slices survive a plain --rebuild.
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-11-1000'))).toBe(true);
  });

  it('--rebuild --include-custom also drops submitted custom slices (kernel slice still safe)', async () => {
    const memoryRoot = join(home, 'memory');
    expect(await init([], { roots })).toBe(0);
    seedKernelSlice(memoryRoot);
    admitSlice(
      memoryRoot,
      makeSubmittedSlice('2026-08-11-1000', '2026-08-11T10:00:00.000Z', '2026-08-11T10:05:00.000Z', 'custom-agent', 'ext-1'),
      'UTC',
    );

    expect(await init(['--rebuild', '--include-custom'], { roots })).toBe(0);
    expect(stdout.join('\n')).toContain('Rebuild: removed 3 transcribed slice(s) (including submitted custom content)');
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-11-1000'))).toBe(false);
    expect(countScribeSlices(memoryRoot)).toBe(2);
    expect(readFileSync(sliceCorePath(memoryRoot, '2026-08-12-0900'), 'utf8')).toContain('内核自己的对话');
  });

  it('--json: the last line is a valid JSON summary with the contract fields', async () => {
    expect(await init(['--json'], { roots })).toBe(0);
    const lastLine = stdout.filter((l) => l.trim() !== '').at(-1)!;
    const summary = JSON.parse(lastLine) as Record<string, unknown>;
    expect(summary).toMatchObject({
      home,
      memoryRoot: join(home, 'memory'),
      backend: null,
      rebuilt: 0,
      errors: [],
    });
    const imported = summary['imported'] as Record<string, { filesProcessed: number; events: number }>;
    expect(imported['claude-code']!.filesProcessed).toBe(1);
    expect(imported['codex']!.filesProcessed).toBe(1);
    expect(summary['nextSteps']).toEqual(
      expect.arrayContaining(['previously start', 'previously open', 'previously install --all']),
    );
  });

  it('--skip-ingest creates only the layout and config, no slices', async () => {
    expect(await init(['--skip-ingest'], { roots })).toBe(0);
    const paths = resolvePaths();
    expect(existsSync(paths.configPath)).toBe(true);
    expect(countScribeSlices(join(home, 'memory'))).toBe(0);
    expect(stdout.join('\n')).not.toContain('transcribed');
  });
});

describe('init wizard (scripted PromptIO)', () => {
  let home: string;
  let roots: ScribeRoots;
  beforeEach(() => {
    home = useTempHome();
    roots = writeFixtureLogs(home);
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  interface ScriptedIO {
    io: PromptIO;
    asked: string[];
    confirmed: string[];
    state: { closed: boolean };
  }

  /**
   * A PromptIO fed from answer queues; an empty queue entry means "pressed
   * enter" (the default is returned), matching the readline implementation.
   */
  function scriptedPromptIO(script: { asks?: string[]; confirms?: boolean[] } = {}): ScriptedIO {
    const asks = [...(script.asks ?? [])];
    const confirms = [...(script.confirms ?? [])];
    const asked: string[] = [];
    const confirmed: string[] = [];
    const state = { closed: false };
    const io: PromptIO = {
      ask: async (question, defaultValue) => {
        asked.push(question);
        return asks.shift() ?? defaultValue;
      },
      confirm: async (question, defaultYes) => {
        confirmed.push(question);
        return confirms.shift() ?? defaultYes;
      },
      close: () => {
        state.closed = true;
      },
    };
    return { io, asked, confirmed, state };
  }

  it('all defaults (enter everywhere): transcribes, writes default config, skips token steps', async () => {
    // --backend none pins the default backend answer so the test does not
    // depend on whether claude/codex/kimi happen to be on this machine's PATH.
    const { io, asked, confirmed, state } = scriptedPromptIO();
    expect(await init(['--backend', 'none'], { roots, isTTY: true, promptIO: io })).toBe(0);

    // Two asks (memory location, backend) and one confirm (transcribe now?),
    // all answered with their defaults — the transcribe default is YES.
    expect(asked).toHaveLength(2);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain('Transcribe this history');
    const config = JSON.parse(readFileSync(resolvePaths().configPath, 'utf8'));
    expect(config.memoryRoot).toBe(join(home, 'memory'));
    expect(config.executionBackend).toBeNull();
    expect(countScribeSlices(join(home, 'memory'))).toBe(2);

    // No usable bridge backend → the token-spending steps are skipped
    // outright, never asked.
    expect(stdout.join('\n')).toContain('No usable bridge backend configured — skipping the optional token-spending steps.');
    expect(confirmed.some((q) => q.includes('OPTIONAL'))).toBe(false);
    expect(state.closed).toBe(true);
  });

  it('existing slices + "keep? no" triggers a rebuild; import can be declined', async () => {
    const memoryRoot = join(home, 'memory');
    // One pre-existing scribe-derived slice.
    admitSlice(
      memoryRoot,
      makeSubmittedSlice('2026-08-09-0800', '2026-08-09T08:00:00.000Z', '2026-08-09T08:05:00.000Z', 'claude-code', 'old-1'),
      'UTC',
    );
    const { io, confirmed } = scriptedPromptIO({
      // keep existing? NO (rebuild) → include custom? NO → transcribe now? NO.
      confirms: [false, false, false],
    });
    expect(await init(['--backend', 'none'], { roots, isTTY: true, promptIO: io })).toBe(0);

    expect(confirmed[0]).toContain('Keep them and import only');
    expect(confirmed[1]).toContain('Also discard externally submitted custom slices?');
    expect(stdout.join('\n')).toContain('Rebuild: removed 1 transcribed slice(s)');
    // The old slice is purged and, with the import declined, nothing came back.
    expect(existsSync(sliceCorePath(memoryRoot, '2026-08-09-0800'))).toBe(false);
    expect(countScribeSlices(memoryRoot)).toBe(0);
    expect(stdout.join('\n')).toContain('history import (run `previously ingest --source <agent>` anytime)');
  });

  it('a broken existing config is offered for repair; "yes" applies it', async () => {
    // Pre-existing config from before the brain field existed: backend picked,
    // brain missing — exactly the incident the config doctor fixes.
    const paths = resolvePaths();
    writeFileSync(
      paths.configPath,
      JSON.stringify({ ...defaultConfig(paths), executionBackend: 'claude' }),
      'utf8',
    );
    const { io, confirmed } = scriptedPromptIO({
      // repair now? YES → transcribe now? NO (keeps it fast; no slices also
      // means the token-spending steps are skipped regardless of PATH).
      confirms: [true, false],
    });
    expect(await init([], { roots, isTTY: true, promptIO: io })).toBe(0);

    expect(confirmed[0]).toContain('Repair these now?');
    const out = stdout.join('\n');
    expect(out).toContain('Your config has issues:');
    expect(out).toContain('brain missing while backend is "claude"');
    expect(out).toContain('Config repaired.');
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config.brain).toEqual({ type: 'bridge', agent: 'claude' });
    expect(existsSync(`${paths.configPath}.bak`)).toBe(true);
  });

  it('declining the config repair keeps the broken config and records the skip', async () => {
    const paths = resolvePaths();
    writeFileSync(
      paths.configPath,
      JSON.stringify({ ...defaultConfig(paths), executionBackend: 'claude' }),
      'utf8',
    );
    const { io } = scriptedPromptIO({
      // repair now? NO → transcribe now? NO.
      confirms: [false, false],
    });
    expect(await init([], { roots, isTTY: true, promptIO: io })).toBe(0);

    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config.brain).toBeUndefined();
    expect(existsSync(`${paths.configPath}.bak`)).toBe(false);
    expect(stdout.join('\n')).toContain('config repairs (declined');
  });
});

describe('init config doctor (non-interactive)', () => {
  let home: string;
  beforeEach(() => {
    home = useTempHome();
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('backfills a missing brain for a bridge backend and prints the repair', async () => {
    const paths = resolvePaths();
    writeFileSync(
      paths.configPath,
      JSON.stringify({ ...defaultConfig(paths), executionBackend: 'claude' }),
      'utf8',
    );
    // Empty fake roots: nothing to transcribe, so this stays fast.
    const roots = makeFakeAgentHome(join(home, 'fakehome'));
    expect(await init([], { roots })).toBe(0);

    expect(stdout.join('\n')).toContain('repaired: brain missing while backend is "claude"');
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config.brain).toEqual({ type: 'bridge', agent: 'claude' });
    // The repair went through applyAudit: the broken original was backed up.
    expect(existsSync(`${paths.configPath}.bak`)).toBe(true);
  });

  it('resets an invalid port and keeps the rest of the config', async () => {
    const paths = resolvePaths();
    writeFileSync(
      paths.configPath,
      JSON.stringify({ ...defaultConfig(paths), port: 99999, customField: 'keep-me' }),
      'utf8',
    );
    const roots = makeFakeAgentHome(join(home, 'fakehome'));
    expect(await init([], { roots })).toBe(0);

    expect(stdout.join('\n')).toContain('repaired: port "99999" is invalid — reset to 3210');
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config.port).toBe(3210);
    expect(config.customField).toBe('keep-me');
  });

  it('a healthy existing config produces no repair output', async () => {
    writeFileSync(resolvePaths().configPath, JSON.stringify(defaultConfig(resolvePaths())), 'utf8');
    // A healthy install also has its memory repo in place — otherwise the
    // doctor legitimately repairs (recreates) it, which this test excludes.
    await ensureMemoryRepo(defaultConfig(resolvePaths()).memoryRoot);
    const roots = makeFakeAgentHome(join(home, 'fakehome'));
    expect(await init([], { roots })).toBe(0);
    expect(stdout.join('\n')).not.toContain('repaired:');
  });
});

describe('init memory repository', () => {
  let home: string;
  beforeEach(() => {
    home = useTempHome();
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  /** Empty fake roots: keeps the history import a fast no-op. */
  const emptyRoots = (): ScribeRoots => makeFakeAgentHome(join(home, 'fakehome'));

  it('creates a git repository (README + first commit) at the default memory root', async () => {
    expect(await init([], { roots: emptyRoots() })).toBe(0);
    const memoryRoot = join(home, 'memory'); // PREVIOUSLY_HOME sandbox default
    expect(existsSync(join(memoryRoot, '.git'))).toBe(true);
    expect(existsSync(join(memoryRoot, 'README.md'))).toBe(true);
    const summary = await repoSummary(memoryRoot);
    expect(summary?.branch).toBe('main');
    expect(summary?.lastCommitAt).not.toBeNull();
    // The empty default memory dir (pre-created by the layout step) is
    // initialized via the doctor's memory audit.
    expect(stdout.join('\n')).toContain('recreated as a git repository');
  });

  it('relink: re-running init with --memory-root adopts an existing Previously repo (the GitHub clone-back path)', async () => {
    expect(await init([], { roots: emptyRoots() })).toBe(0);

    // A memory repo the user cloned back from their private GitHub remote.
    const clone = join(home, 'cloned-back');
    await ensureMemoryRepo(clone);
    mkdirSync(join(clone, 'episodic'), { recursive: true });
    writeFileSync(join(clone, 'episodic', 'timeline.md'), '# Timeline\n', 'utf8');
    await commitAll(clone, 'Previously content');

    expect(await init(['--memory-root', clone], { roots: emptyRoots() })).toBe(0);
    const config = JSON.parse(readFileSync(resolvePaths().configPath, 'utf8'));
    expect(config.memoryRoot).toBe(clone);
    expect(stdout.join('\n')).toContain('Adopted the existing Previously memory repository');
    // Data untouched: the committed content is still there, tree still clean.
    expect(readFileSync(join(clone, 'episodic', 'timeline.md'), 'utf8')).toBe('# Timeline\n');
    expect((await repoSummary(clone))?.uncommitted).toBe(0);
  });

  it('refuses a foreign non-empty non-git --memory-root: exit 1, nothing initialized over it', async () => {
    const foreign = join(home, 'foreign');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'precious.txt'), 'do not touch\n', 'utf8');

    expect(await init(['--memory-root', foreign], { roots: emptyRoots() })).toBe(1);
    expect(stderr.join('\n')).toContain('refusing to initialize a repository over it');
    expect(stderr.join('\n')).toContain('--memory-root');
    expect(existsSync(join(foreign, '.git'))).toBe(false);
  });
});
