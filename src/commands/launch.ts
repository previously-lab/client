import { existsSync } from 'node:fs';
import { countScribeSlices } from '../lib/ingest.js';
import { resolvePaths } from '../lib/paths.js';
import { collectStatus, nextStepSuggestion, type SystemStatus } from '../lib/system-status.js';
import { getPinnedKernelVersion } from '../lib/version-policy.js';
import { SCRIBE_SOURCES } from '../scribe/types.js';
import { run as initRun, type InitOptions } from './init.js';
import { formatScribeSource, run as statusRun } from './status.js';

/**
 * Bare `previously` — the front door:
 *
 *  1. never initialized → run the initialization flow (the wizard on a TTY,
 *     non-interactive defaults otherwise, so an agent can just say
 *     "initialize previously" and it works)
 *  2. initialized        → print the status dashboard (TTY) or exactly
 *     `previously status` output (non-TTY, script-safe)
 *
 * The bare command never starts services and never opens a browser —
 * that is `previously start` / `previously open`.
 */

export interface LaunchDeps {
  /** Defaults to stdin+stdout TTY detection. */
  isTTY?: boolean;
  /** Dependency seams so tests never touch the real machine. */
  initFn?: (args: string[], opts?: InitOptions) => Promise<number>;
  statusFn?: (args: string[]) => Promise<number>;
  statusCollector?: typeof collectStatus;
}

function printDashboard(s: SystemStatus): void {
  const { paths, config } = s;
  const url = `http://${config.hostname}:${config.port}`;

  console.log('Previously — status');
  console.log('');
  console.log(
    `Service:   ${s.kernelAlive ? `running (pid ${s.kernelPid})` : 'not running — start with `previously start`'} · Web UI ${url} (${s.reachable ? 'reachable' : 'unreachable'})`,
  );
  if (s.kernelAlive) console.log('           stop with `previously stop`');
  if (s.kernelVersion !== null) {
    console.log(
      `Version:   ${s.kernelVersion} (pinned ${getPinnedKernelVersion()} — ${s.compat!.ok ? 'compatible' : 'INCOMPATIBLE'})`,
    );
  }
  console.log(`Scribe:    ${s.scribeAlive ? `running (pid ${s.scribePid})` : 'not running'}`);
  for (const source of SCRIBE_SOURCES) {
    console.log(formatScribeSource(source, s.scribeStatus));
  }
  console.log(`Storage:   ${config.memoryRoot} — ${countScribeSlices(config.memoryRoot)} transcribed slice(s)`);
  console.log(`Backend:   ${config.executionBackend ?? '(unset)'}`);
  for (const bridge of s.bridges) {
    console.log(`  bridge ${bridge.agent}: ${bridge.found ? 'found' : 'not found'}`);
  }

  const suggestion = nextStepSuggestion(s);
  if (suggestion !== null) {
    console.log('');
    console.log(`Next:      ${suggestion}`);
  }

  console.log('');
  console.log('Commands:  previously start · stop · status · logs · open · init — `previously --help` for everything');
}

export async function run(args: string[], deps: LaunchDeps = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const isTTY = deps.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));

  // State 1: never initialized — the bare command IS initialization.
  if (!existsSync(paths.configPath)) {
    return (deps.initFn ?? initRun)([], { isTTY: isTTY });
  }

  // State 2: initialized. Non-TTY stays exactly `previously status` so
  // scripts and CI get stable, parseable output.
  if (!isTTY) return (deps.statusFn ?? statusRun)([]);

  const s = await (deps.statusCollector ?? collectStatus)(paths);
  printDashboard(s);
  return 0;
}
