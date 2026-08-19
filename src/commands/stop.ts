import { resolvePaths } from '../lib/paths.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  terminateProcess,
} from '../lib/process.js';

export interface StopOptions {
  /** Grace period before force-kill; defaults to PREVIOUSLY_STOP_TIMEOUT_MS env or 10s. */
  graceTimeoutMs?: number;
}

/** Stop one managed process by pid file. Returns false on a hard failure. */
async function stopOne(label: string, pidPath: string, graceTimeoutMs: number): Promise<boolean> {
  const pid = readPidFile(pidPath);
  if (pid === null) {
    console.log(`${label} is not running (no pid file).`);
    return true;
  }
  if (!isProcessAlive(pid)) {
    removePidFile(pidPath);
    console.log(`${label} is not running; removed stale pid file (pid ${pid}).`);
    return true;
  }

  await terminateProcess(pid, graceTimeoutMs);
  removePidFile(pidPath);

  if (isProcessAlive(pid)) {
    console.error(`Failed to stop ${label.toLowerCase()} (pid ${pid} still alive after force kill).`);
    return false;
  }
  console.log(`${label} stopped (pid ${pid}).`);
  return true;
}

/**
 * `previously stop` — SIGTERM the scribe and the kernel, escalate to a force
 * kill after the grace period, clean up pid files. Stale pid files are
 * removed quietly. The scribe goes first so no session-log events are
 * transcribed into a half-stopped system.
 */
export async function run(args: string[], opts: StopOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const graceTimeoutMs =
    opts.graceTimeoutMs ?? Number(process.env.PREVIOUSLY_STOP_TIMEOUT_MS ?? 10_000);

  const scribeOk = await stopOne('Scribe', paths.scribePidPath, graceTimeoutMs);
  const kernelOk = await stopOne('Previously kernel', paths.pidPath, graceTimeoutMs);
  return scribeOk && kernelOk ? 0 : 1;
}
