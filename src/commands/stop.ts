import { resolvePaths } from '../lib/paths.js';
import { err, muted, ok } from '../lib/ansi.js';
import { loadConfig } from '../lib/config.js';
import { parseMsEnv } from '../lib/env.js';
import { commitAll } from '../lib/memory-repo.js';
import {
  checkPidFile,
  isProcessAlive,
  removePidFile,
  terminateProcess,
} from '../lib/process.js';

export interface StopOptions {
  /** Grace period before force-kill; defaults to PREVIOUSLY_STOP_TIMEOUT_MS env or 10s. */
  graceTimeoutMs?: number;
}

/** Stop one managed process by pid file. Returns false on a hard failure. */
async function stopOne(label: string, pidPath: string, graceTimeoutMs: number): Promise<boolean> {
  const { status, pid } = checkPidFile(pidPath);
  if (status === 'none') {
    console.log(muted(`${label} is not running (no pid file).`));
    return true;
  }
  if (status === 'stale') {
    removePidFile(pidPath);
    console.log(muted(`${label} is not running; removed stale pid file (pid ${pid}).`));
    return true;
  }
  if (status === 'foreign') {
    // The recorded pid was reused by an unrelated process — never kill it.
    removePidFile(pidPath);
    console.log(muted(`${label} pid file pointed at an unrelated process (pid ${pid}); removed it, process left alone.`));
    return true;
  }

  // status === 'running' implies pid is non-null.
  const livePid = pid!;
  await terminateProcess(livePid, graceTimeoutMs);
  removePidFile(pidPath);

  if (isProcessAlive(livePid)) {
    console.error(err(`Failed to stop ${label.toLowerCase()} (pid ${livePid} still alive after force kill).`));
    return false;
  }
  console.log(ok(`${label} stopped (pid ${livePid}).`));
  return true;
}

/**
 * `previously stop` — SIGTERM the scribe and the kernel, escalate to a force
 * kill after the grace period, clean up pid files. Stale pid files are
 * removed quietly. The scribe goes first so no session-log events are
 * transcribed into a half-stopped system. Afterwards, any uncommitted memory
 * changes are swept into the memory repo (when it is one).
 */
export async function run(args: string[], opts: StopOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const graceTimeoutMs =
    opts.graceTimeoutMs ?? parseMsEnv('PREVIOUSLY_STOP_TIMEOUT_MS', 10_000);

  const scribeOk = await stopOne('Scribe', paths.scribePidPath, graceTimeoutMs);
  const kernelOk = await stopOne('Previously kernel', paths.pidPath, graceTimeoutMs);

  // Safety net: sweep anything the scribe/kernel left uncommitted into the
  // memory repo (a no-op when the memory root is not a git repository).
  await commitAll(loadConfig(paths).memoryRoot, 'Sweep: uncommitted changes');

  return scribeOk && kernelOk ? 0 : 1;
}
