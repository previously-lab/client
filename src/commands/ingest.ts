import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dispatchBridgeTask, BridgeError, resolveTimeoutMs } from '../bridge/index.js';
import { loadConfig, resolveBrainAgent } from '../lib/config.js';
import { admitSlice, IngestError, parseSubmittedSlice } from '../lib/ingest.js';
import {
  applyMark,
  compressSliceForMarking,
  findDrySlices,
  MARKING_TASK,
  parseMarkingResponse,
} from '../lib/marking.js';
import { resolvePaths } from '../lib/paths.js';
import { parseSliceId, sliceIdToRelDir } from '../lib/slices.js';
import { join } from 'node:path';
import { createEngine } from './scribe.js';
import { listSessionFiles, resolveScribeRoots, sourceFileMatcher, type ScribeEngine } from '../scribe/watcher.js';
import { SCRIBE_SOURCES, type ScribeRoots, type ScribeSource } from '../scribe/types.js';

/**
 * `previously ingest` — the admission door for EXTERNAL memory writes.
 * Callers (a user, or an agent acting for them) never write the memory
 * directory directly; they hand content to us and we validate + store it.
 *
 * Three modes:
 *
 *   ingest --source <claude-code|codex|kimi-code|gemini> [--root <dir> | --path <file>]
 *     Raw-log mode: hand us agent session logs, we run them through the scribe
 *     transcription pipeline (same parsers/slicer as `previously watch`).
 *     Default with neither --root nor --path: that source's standard log root.
 *     Pure local work — no model calls, no token cost.
 *
 *   ingest --submit <file|->
 *     Rendered-doc mode: the caller (typically an agent that already processed
 *     its own conversation) submits ONE complete slice document in the
 *     kernel's core.md shape. We validate strictly; on any violation we print
 *     every issue and write nothing. On pass we render canonically and write
 *     it ourselves. Submitted slices must be status: closed. Dedup by
 *     (source, session_id): identical re-submit is a no-op, diverging content
 *     is a hard error — ingest never overwrites.
 *
 *   ingest --mark [--agent claude|codex|kimi] [--yes]
 *     Eager semantic marking: one bridge-brain model call per dry slice fills
 *     focus/summary/tags. TOKEN-SPENDING. Without --yes we only print the
 *     estimate (how many slices → how many calls via which agent) and stop;
 *     one --yes covers one batch.
 *
 * Exit codes: 0 ok (or estimate printed), 1 content/validation failures,
 * 2 usage errors.
 */

function usage(): void {
  console.log(`previously ingest — admit external content into Previously memory

Modes:
  --source <${SCRIBE_SOURCES.join('|')}>
                    Transcribe raw agent session logs (we parse + slice + store).
                    Default: the source's standard log root. No token cost.
    --root <dir>    Scan this directory instead of the standard root
    --path <file>   Ingest exactly this one log file (e.g. an export)
  --submit <file|-> Submit one fully-rendered slice document for validation +
                    storage by us ('-' reads stdin). Strict contract — see the
                    ingest skill doc. No token cost.
  --mark            Fill focus/summary/tags of dry slices via the bridge brain.
                    TOKEN-SPENDING: one model call per dry slice.
    --agent <claude|codex|kimi>  Which subscription CLI to use (default: config)
    --yes           Confirm the estimated batch and actually spend

Ingested slices are historical: they never trigger card evolution and never
get card snapshots. See \`previously card bootstrap\` for the 前情提要.`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--submit - expects the slice document on stdin (pipe it in).');
  }
  return new Promise((resolveStdin, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', reject);
  });
}

function parseSource(value: string | undefined): ScribeSource {
  if ((SCRIBE_SOURCES as readonly string[]).includes(value ?? '')) return value as ScribeSource;
  throw new Error(`Unknown --source value: ${value ?? '(missing)'} (expected ${SCRIBE_SOURCES.join('|')})`);
}

/** Raw-log mode: run files through the scribe pipeline. */
async function runSourceMode(
  source: ScribeSource,
  root: string | undefined,
  filePath: string | undefined,
): Promise<number> {
  const paths = resolvePaths();
  const roots: ScribeRoots = { ...resolveScribeRoots(), ...(root !== undefined ? { [source]: root } : {}) };
  const engine: ScribeEngine = createEngine(paths, roots);
  engine.loadCursors();

  const files =
    filePath !== undefined
      ? [filePath]
      : listSessionFiles(roots[source], sourceFileMatcher(source));

  if (filePath !== undefined && !existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return 1;
  }
  if (files.length === 0) {
    console.log(`${source}: no session log files found under ${filePath ?? roots[source]}`);
    return 0;
  }

  let failures = 0;
  for (const file of files) {
    try {
      const result = await engine.processFile(file, source);
      if (result === null) {
        console.log(`  ${file}: skipped (not a regular file)`);
        continue;
      }
      const slice = result.sliceId ?? '(no parseable events)';
      console.log(`  ${file}: slice ${slice}, ${result.newEvents} events, ${result.newParseErrors} parse errors`);
    } catch (err) {
      failures++;
      console.error(`  ${file}: ERROR ${err instanceof Error ? err.message : err}`);
    }
  }
  engine.writeStatus();
  console.log(`${source}: ${files.length - failures}/${files.length} files ingested. Memory root: ${loadConfig(paths).memoryRoot}`);
  return failures > 0 ? 1 : 0;
}

/** Rendered-doc mode: validate, then we write. */
async function runSubmitMode(submitPath: string): Promise<number> {
  let doc: string;
  try {
    doc = submitPath === '-' ? await readStdin() : readFileSync(submitPath, 'utf8');
  } catch (err) {
    console.error(`Could not read ${submitPath}: ${err instanceof Error ? err.message : err}`);
    return 2;
  }

  const { slice, issues, dropped } = parseSubmittedSlice(doc);
  if (slice === null) {
    console.error(`Submission rejected — ${issues.length} issue(s). Fix and resubmit; nothing was written.`);
    for (const issue of issues) console.error(`  issue: ${issue.path}: ${issue.message}`);
    return 1;
  }
  for (const key of dropped) {
    console.error(`  note: unknown frontmatter key "${key}" dropped by canonical rendering`);
  }

  const config = loadConfig(resolvePaths());
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    const result = admitSlice(config.memoryRoot, slice, timezone);
    if (result.action === 'duplicate') {
      console.log(`Already ingested (identical content): slice ${result.sliceId} — nothing written.`);
    } else {
      if (result.remappedFrom !== null) {
        console.log(`Slice id ${result.remappedFrom} was taken by another session; remapped to ${result.sliceId}.`);
      }
      console.log(`Ingested as slice ${result.sliceId}: ${result.path}`);
      if (slice.focus === '' && slice.summary === '') {
        console.log('Note: slice is dry (no focus/summary) — the kernel backfills it lazily, or run `previously ingest --mark` (spends tokens).');
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof IngestError) {
      console.error(`Submission rejected: ${err.message}`);
      for (const issue of err.issues) console.error(`  issue: ${issue.path}: ${issue.message}`);
      return 1;
    }
    throw err;
  }
}

/** Eager marking mode: estimate-first, spend only with --yes. */
async function runMarkMode(agentFlag: string | undefined, yes: boolean): Promise<number> {
  const paths = resolvePaths();
  const config = loadConfig(paths);
  const agent = resolveBrainAgent(agentFlag, config);
  const dry = findDrySlices(config.memoryRoot);
  if (dry.length === 0) {
    console.log('No dry slices (every slice has a focus or summary). Nothing to do.');
    return 0;
  }

  console.log(`Marking plan: ${dry.length} dry slice(s) → ${dry.length} model call(s) via ${agent} (your subscription).`);
  if (!yes) {
    console.log('This spends tokens. Re-run with --yes to confirm this batch (one confirmation per batch).');
    return 0;
  }

  let ok = 0;
  let failed = 0;
  for (const ref of dry) {
    const parts = parseSliceId(ref.sliceId)!;
    const corePath = join(
      config.memoryRoot,
      'episodic',
      'slices',
      ...sliceIdToRelDir(parts).split('/'),
      'timeline',
      'core.md',
    );
    try {
      const core = readFileSync(corePath, 'utf8');
      const text = await dispatchBridgeTask(
        agent,
        { task: MARKING_TASK, context: compressSliceForMarking(core) },
        { timeoutMs: resolveTimeoutMs(agent) },
      );
      const mark = parseMarkingResponse(text);
      const { skippedKeys } = applyMark(config.memoryRoot, ref.sliceId, mark);
      ok++;
      console.log(
        `  ${ref.sliceId}: marked (${mark.focus || mark.summary})` +
          (skippedKeys.length > 0 ? ` — left untouched: ${skippedKeys.join(', ')}` : ''),
      );
    } catch (err) {
      failed++;
      const reason = err instanceof BridgeError ? `[${err.reason}] ` : '';
      console.error(`  ${ref.sliceId}: FAILED ${reason}${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Marking done: ${ok} marked, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

export async function run(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        source: { type: 'string' },
        root: { type: 'string' },
        path: { type: 'string' },
        submit: { type: 'string' },
        mark: { type: 'boolean' },
        agent: { type: 'string' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    return 2;
  }
  if (values.help === true) {
    usage();
    return 0;
  }

  const modes = [values.source !== undefined, values.submit !== undefined, values.mark === true].filter(Boolean).length;
  if (modes !== 1) {
    console.error('Choose exactly one mode: --source, --submit, or --mark.');
    usage();
    return 2;
  }
  if (values.root !== undefined && values.path !== undefined) {
    console.error('--root and --path are mutually exclusive.');
    return 2;
  }

  try {
    if (values.source !== undefined) {
      return await runSourceMode(parseSource(values.source), values.root, values.path);
    }
    if (values.submit !== undefined) {
      return await runSubmitMode(values.submit);
    }
    return await runMarkMode(values.agent, values.yes === true);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof IngestError ? 1 : 2;
  }
}
