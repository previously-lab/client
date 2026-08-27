import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { rotateLogIfOversize } from './log-rotate.js';
import { sleep } from './sleep.js';

/**
 * Platform-isolated process management. All pid-file, detached-spawn, and
 * signal semantics live here so the commands stay platform-agnostic.
 *
 * Windows notes:
 * - There is no real SIGTERM; `process.kill(pid, 'SIGTERM')` maps to
 *   TerminateProcess (an immediate kill). Escalation uses `taskkill /F`.
 * - `detached: true` + `unref()` still allows the parent to exit while the
 *   child keeps running.
 */

export function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Write a pid file. `marker` (a substring of the managed process's command
 * line, e.g. the kernel's server.js path) is stored on a second line so
 * later checks can tell our process apart from a reused pid — see
 * checkPidFile.
 */
export function writePidFile(pidPath: string, pid: number, marker?: string): void {
  writeFileSync(pidPath, marker ? `${pid}\n${marker}\n` : `${pid}\n`, 'utf8');
}

export function removePidFile(pidPath: string): void {
  rmSync(pidPath, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user — treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort command line of a live process; null when it cannot be
 * determined (query failed, unsupported platform). Windows pays one
 * PowerShell CIM query per call — keep this off hot paths.
 */
export function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      );
      if (res.error || res.status !== 0) return null;
      const line = (res.stdout ?? '').trim();
      return line.length > 0 ? line : null;
    }
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.error || res.status !== 0) return null;
    const line = (res.stdout ?? '').trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

export type PidFileStatus = 'none' | 'stale' | 'foreign' | 'running';

/**
 * Liveness PLUS identity for a managed pid file. Pid files survive crashes
 * and Windows reuses pids aggressively, so a live pid alone does not prove
 * the process is ours — `previously stop` must never taskkill a stranger.
 *
 * New-style pid files carry a second line: a marker substring of the
 * expected command line (the kernel's server.js path, `<entry> watch` for
 * the scribe), written at spawn time. Legacy bare pid files fall back to
 * alive-only — the pre-marker behavior. When the live command line cannot
 * be read we conservatively answer 'running': refusing to start (or killing
 * the wrong process) is worse than a stale claim.
 */
export function checkPidFile(pidPath: string): { status: PidFileStatus; pid: number | null } {
  const pid = readPidFile(pidPath);
  if (pid === null) return { status: 'none', pid: null };
  if (!isProcessAlive(pid)) return { status: 'stale', pid };
  const marker = readPidMarker(pidPath);
  if (marker === null) return { status: 'running', pid };
  const cmdline = processCommandLine(pid);
  if (cmdline === null) return { status: 'running', pid };
  return { status: cmdline.includes(marker) ? 'running' : 'foreign', pid };
}

/** The identity marker line of a pid file, or null for legacy bare files. */
export function readPidMarker(pidPath: string): string | null {
  if (!existsSync(pidPath)) return null;
  const second = readFileSync(pidPath, 'utf8').split('\n')[1]?.trim();
  return second ? second : null;
}

/** Resolve true once the process is gone; false if still alive after timeoutMs. */
export async function waitForExit(pid: number, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !isProcessAlive(pid);
}

/**
 * Signal the process, and on POSIX its whole process group. The kernel and
 * scribe are spawned `detached` (group leaders), so `-pid` reaches the
 * children they spawned in turn (bridge-exec, agent CLIs) instead of leaving
 * orphans. Falls back to the bare pid when the group is already gone.
 */
function killGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Graceful-then-forceful termination; tolerates the process dying on its own. */
export async function terminateProcess(pid: number, graceTimeoutMs: number): Promise<void> {
  killGroupOrProcess(pid, 'SIGTERM');
  if (await waitForExit(pid, graceTimeoutMs)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    killGroupOrProcess(pid, 'SIGKILL');
  }
  await waitForExit(pid, 5_000);
}

export interface SpawnKernelOptions {
  serverJs: string;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}

/**
 * Spawn `node server.js` detached, stdout/stderr appended to logPath.
 * Returns the child pid. The log is size-capped: rotated before open when it
 * has grown past the cap (see log-rotate.ts).
 */
export function spawnKernelDetached({ serverJs, cwd, env, logPath }: SpawnKernelOptions): number {
  rotateLogIfOversize(logPath);
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [serverJs], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  // The fd is duplicated into the child; the parent must not hold it open
  // (on Windows a held fd would lock the log file against deletion).
  closeSync(out);
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn kernel process: ${serverJs}`);
  }
  return child.pid;
}

export interface SpawnScribeOptions {
  /** Path to the CLI entry (dist/cli.js); the scribe runs `node cli.js watch`. */
  cliEntry: string;
  logPath: string;
}

/**
 * Spawn the scribe as a second detached process (`node cli.js watch`),
 * stdout/stderr appended to logPath. Returns the child pid. Kept separate
 * from spawnKernelDetached: the scribe has its own pid file and lifecycle.
 */
export function spawnScribeDetached({ cliEntry, logPath }: SpawnScribeOptions): number {
  rotateLogIfOversize(logPath);
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [cliEntry, 'watch'], {
    env: process.env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn scribe process: ${cliEntry}`);
  }
  return child.pid;
}

