import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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

export function writePidFile(pidPath: string, pid: number): void {
  writeFileSync(pidPath, String(pid) + '\n', 'utf8');
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

/** Resolve true once the process is gone; false if still alive after timeoutMs. */
export async function waitForExit(pid: number, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !isProcessAlive(pid);
}

/** Graceful-then-forceful termination; tolerates the process dying on its own. */
export async function terminateProcess(pid: number, graceTimeoutMs: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  if (await waitForExit(pid, graceTimeoutMs)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
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
 * Returns the child pid.
 */
export function spawnKernelDetached({ serverJs, cwd, env, logPath }: SpawnKernelOptions): number {
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [serverJs], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
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
