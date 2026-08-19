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

/**
 * `previously stop` — SIGTERM the kernel, escalate to a force kill after the
 * grace period, clean up the pid file. Stale pid files are removed quietly.
 */
export async function run(args: string[], opts: StopOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();

  const pid = readPidFile(paths.pidPath);
  if (pid === null) {
    console.log('Previously kernel is not running (no pid file).');
    return 0;
  }
  if (!isProcessAlive(pid)) {
    removePidFile(paths.pidPath);
    console.log(`Previously kernel is not running; removed stale pid file (pid ${pid}).`);
    return 0;
  }

  const graceTimeoutMs =
    opts.graceTimeoutMs ?? Number(process.env.PREVIOUSLY_STOP_TIMEOUT_MS ?? 10_000);
  await terminateProcess(pid, graceTimeoutMs);
  removePidFile(paths.pidPath);

  if (isProcessAlive(pid)) {
    console.error(`Failed to stop kernel process (pid ${pid} still alive after force kill).`);
    return 1;
  }
  console.log(`Previously kernel stopped (pid ${pid}).`);
  return 0;
}
