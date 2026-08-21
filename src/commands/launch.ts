import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { openBrowser, type OpenResult } from '../lib/open-browser.js';
import { resolvePaths } from '../lib/paths.js';
import { isProcessAlive, readPidFile } from '../lib/process.js';
import { run as startRun, type StartOptions } from './start.js';
import { run as statusRun } from './status.js';

/**
 * Bare `previously` — the one command an AI user ever needs. A small state
 * machine over the local setup:
 *
 *  1. no config.json          → honest guidance to run `previously init`, exit 1
 *  2. initialized, not running → start, open the Web UI, print a short summary
 *  3. running                  → open the Web UI, print a short summary
 *
 * All interactive UX lives in the kernel's Web UI — the CLI ends after
 * "started + browser opened". Non-TTY degrades to pure text: state 2 starts
 * and reports, state 3 is exactly `previously status`, so scripts and CI can
 * call the bare command safely.
 */

export interface LaunchDeps {
  /** Defaults to stdin+stdout TTY detection. */
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Dependency seams so tests never spawn real processes. */
  startFn?: (args: string[], opts?: StartOptions) => Promise<number>;
  statusFn?: (args: string[]) => Promise<number>;
  openBrowserFn?: (url: string) => OpenResult;
}

function maybeOpen(url: string, deps: LaunchDeps): void {
  if (deps.openBrowserFn !== undefined) {
    const result = deps.openBrowserFn(url);
    if (!result.ok) console.error(`Could not open the browser (${result.error ?? 'unknown error'}) — open ${url} manually.`);
    return;
  }
  const result = openBrowser(url, { env: deps.env });
  if (!result.ok) console.error(`Could not open the browser (${result.error ?? 'unknown error'}) — open ${url} manually.`);
}

function printSummary(url: string, alreadyRunning: boolean): void {
  console.log(alreadyRunning ? 'Previously is already running.' : 'Previously is running.');
  console.log(`  Web UI: ${url}`);
  console.log('  Stop:   previously stop');
}

export async function run(args: string[], deps: LaunchDeps = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const isTTY = deps.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));

  // State 1: never initialized. init is non-interactive, so the guidance is
  // the same with or without a terminal.
  if (!existsSync(paths.configPath)) {
    console.error('Previously is not initialized yet (no config.json).');
    console.error('Run `previously init` to create the ~/.previously layout and a default config.');
    return 1;
  }

  const config = loadConfig(paths);
  const url = `http://${config.hostname}:${config.port}`;
  const pid = readPidFile(paths.pidPath);
  const alive = pid !== null && isProcessAlive(pid);

  // State 2: initialized but the kernel is down — bring it up (start.run owns
  // stale pid cleanup, port checks, scribe auto-start, honest failures).
  if (!alive) {
    const code = await (deps.startFn ?? startRun)([]);
    if (code !== 0) return code;
    if (!isTTY) {
      console.log(`Previously is running at ${url}`);
      return 0;
    }
    maybeOpen(url, deps);
    printSummary(url, false);
    return 0;
  }

  // State 3: already running.
  if (!isTTY) return (deps.statusFn ?? statusRun)([]);
  maybeOpen(url, deps);
  printSummary(url, true);
  return 0;
}
