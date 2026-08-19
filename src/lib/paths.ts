import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved on-disk layout of the Previously client home directory.
 *
 * All paths root at PREVIOUSLY_HOME when that env var is set (this is how
 * tests and sandboxed runs avoid touching the real user home); otherwise
 * they root at `~/.previously`.
 */
export interface PreviouslyPaths {
  home: string;
  memoryDir: string;
  kernelDir: string;
  /** Versioned kernel installs live here: <kernelVersionsDir>/<version>/ */
  kernelVersionsDir: string;
  /** JSON pointer to the active kernel version: { version, dir, previous? } */
  kernelCurrentPath: string;
  /** Scratch dir for the shallow clone of the agent repo during kernel install. */
  agentRepoCacheDir: string;
  logsDir: string;
  configPath: string;
  pidPath: string;
  kernelLogPath: string;
  /** Scribe state root: cursors, per-session event state, status. */
  scribeDir: string;
  scribeCursorsPath: string;
  scribeSessionsDir: string;
  scribeStatusPath: string;
  scribePidPath: string;
  scribeLogPath: string;
}

export function resolvePaths(): PreviouslyPaths {
  const home = process.env.PREVIOUSLY_HOME ?? join(homedir(), '.previously');
  const kernelDir = join(home, 'kernel');
  return {
    home,
    memoryDir: join(home, 'memory'),
    kernelDir,
    kernelVersionsDir: join(kernelDir, 'versions'),
    kernelCurrentPath: join(kernelDir, 'current.json'),
    agentRepoCacheDir: join(home, 'cache', 'agent-repo'),
    logsDir: join(home, 'logs'),
    configPath: join(home, 'config.json'),
    pidPath: join(home, 'kernel.pid'),
    kernelLogPath: join(home, 'logs', 'kernel.log'),
    scribeDir: join(home, 'scribe'),
    scribeCursorsPath: join(home, 'scribe', 'cursors.json'),
    scribeSessionsDir: join(home, 'scribe', 'sessions'),
    scribeStatusPath: join(home, 'scribe', 'status.json'),
    scribePidPath: join(home, 'scribe.pid'),
    scribeLogPath: join(home, 'logs', 'scribe.log'),
  };
}
