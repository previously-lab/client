import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { parseMsEnv } from '../lib/env.js';
import { resolvePaths, type PreviouslyPaths } from '../lib/paths.js';
import { checkPidFile, readPidFile, removePidFile, writePidFile } from '../lib/process.js';
import { bold, emph, err as errText, muted, ok, red, warn } from '../lib/ansi.js';
import { CursorStore } from '../scribe/cursor.js';
import { SCRIBE_SOURCES, type ScribeRoots, type ScribeSource } from '../scribe/types.js';
import { resolveScribeRoots, ScribeEngine, ScribeWatcher } from '../scribe/watcher.js';

export interface ScribeCommandOptions {
  /** Test hook: override the per-agent log roots instead of using $HOME. */
  roots?: ScribeRoots;
}

/** Build the engine exactly once per process, from config + paths. */
export function createEngine(
  paths: PreviouslyPaths,
  roots: ScribeRoots = resolveScribeRoots(),
): ScribeEngine {
  const config = loadConfig(paths);
  return new ScribeEngine({
    memoryRoot: config.memoryRoot,
    sessionsDir: paths.scribeSessionsDir,
    cursorStore: new CursorStore(paths.scribeCursorsPath),
    statusPath: paths.scribeStatusPath,
    roots,
  });
}

function parseSourceArg(args: string[]): ScribeSource | undefined {
  const idx = args.indexOf('--source');
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if ((SCRIBE_SOURCES as readonly string[]).includes(value ?? '')) return value as ScribeSource;
  throw new Error(`Unknown --source value: ${value ?? '(missing)'} (expected ${SCRIBE_SOURCES.join('|')})`);
}

function formatSourceLine(source: ScribeSource, s: {
  rootPresent: boolean; root: string; filesSeen: number; filesProcessed: number;
  events: number; parseErrors: number; lastEventAt: string | null;
}): string {
  if (!s.rootPresent) return `  ${bold(source)}: ${warn(`root absent (${s.root})`)}`;
  const last = s.lastEventAt ?? '—';
  const parseErrors = s.parseErrors > 0 ? red(String(s.parseErrors)) : String(s.parseErrors);
  return `  ${bold(source)}: ${s.filesProcessed}/${s.filesSeen} files, ${s.events} events, ${parseErrors} parse errors, last event ${last}`;
}

/**
 * `previously scribe once [--source claude-code|codex|kimi-code|gemini]` —
 * one-shot full scan of the agent session logs without watching.
 * Backfill + debugging.
 */
export async function runScribe(args: string[], opts: ScribeCommandOptions = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'once') {
    console.error(errText(`Usage: previously scribe once [--source ${SCRIBE_SOURCES.join('|')}]`));
    return 2;
  }
  let source: ScribeSource | undefined;
  try {
    source = parseSourceArg(rest);
  } catch (err) {
    console.error(errText(err instanceof Error ? err.message : String(err)));
    return 2;
  }

  const paths = resolvePaths();
  const engine = createEngine(paths, opts.roots);
  const summary = await engine.scanOnce(source);

  const sources = source !== undefined ? [source] : SCRIBE_SOURCES;
  for (const s of sources) {
    console.log(formatSourceLine(s, summary.sources[s]));
  }
  for (const err of summary.errors) {
    console.error(errText(`  error: ${err.file}: ${err.message}`));
  }
  console.log(`${bold('Memory root:')} ${emph(loadConfig(paths).memoryRoot)}`);
  return 0;
}

export interface WatchOptions extends ScribeCommandOptions {
  /** Periodic full-rescan interval; defaults to PREVIOUSLY_SCRIBE_RESCAN_MS or 5 min. */
  rescanMs?: number;
}

/**
 * `previously watch` — run the scribe in the foreground: initial full scan,
 * then chokidar fs watch over the agent session log roots, plus a periodic
 * rescan safety net. Runs until SIGINT/SIGTERM. This is also the process that
 * `previously start` spawns detached.
 */
export async function runWatch(args: string[], opts: WatchOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();

  const existingPid = readPidFile(paths.scribePidPath);
  // Note: when `previously start` spawns us detached, it writes OUR pid into
  // the pid file — seeing our own pid there is the normal case, not a clash.
  if (existingPid !== null && existingPid !== process.pid) {
    const existing = checkPidFile(paths.scribePidPath);
    if (existing.status === 'running') {
      console.error(errText(`Scribe is already running (pid ${existing.pid}).`));
      return 1;
    }
    removePidFile(paths.scribePidPath);
  }

  const roots = opts.roots ?? resolveScribeRoots();
  const engine = createEngine(paths, roots);
  const watcher = new ScribeWatcher(engine, roots);

  // Long-running process safety net (§9 failure philosophy): a rejected
  // promise that escaped every local catch is still surfaced honestly — into
  // the scribe status file and the scribe log (stdout in detached mode) —
  // instead of crashing the watcher or vanishing silently.
  process.on('unhandledRejection', (reason) => {
    engine.recordErrorSafe('(unhandledRejection)', reason);
    console.error(errText(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
  });

  mkdirSync(paths.logsDir, { recursive: true });
  // Carry the identity marker (see process.ts checkPidFile) only when this is
  // a real CLI process; in-process test callers keep the legacy bare pid.
  const marker = process.argv[1]?.endsWith('cli.js') ? `${basename(process.argv[1])} watch` : undefined;
  writePidFile(paths.scribePidPath, process.pid, marker);

  const rescanMs = opts.rescanMs ?? parseMsEnv('PREVIOUSLY_SCRIBE_RESCAN_MS', 300_000);
  const timer = setInterval(() => {
    watcher.rescan().catch((err) => {
      engine.recordErrorSafe('(rescan)', err);
      console.error(errText(`rescan failed: ${err instanceof Error ? err.message : err}`));
    });
  }, rescanMs);
  timer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await watcher.stop();
    removePidFile(paths.scribePidPath);
  };
  const onSignal = (): void => {
    shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(errText(`shutdown failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await watcher.start();
  await engine.drain();
  await engine.commitBatch();

  for (const source of SCRIBE_SOURCES) {
    console.log(formatSourceLine(source, engine.getStatus().sources[source]));
  }
  console.log(ok(`Scribe watching (pid ${process.pid}).`) + ` ${muted('Status:')} ${emph(paths.scribeStatusPath)}`);
  return 0;
}
