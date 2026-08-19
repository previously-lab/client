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
  logsDir: string;
  configPath: string;
  pidPath: string;
  kernelLogPath: string;
}

export function resolvePaths(): PreviouslyPaths {
  const home = process.env.PREVIOUSLY_HOME ?? join(homedir(), '.previously');
  return {
    home,
    memoryDir: join(home, 'memory'),
    kernelDir: join(home, 'kernel'),
    logsDir: join(home, 'logs'),
    configPath: join(home, 'config.json'),
    pidPath: join(home, 'kernel.pid'),
    kernelLogPath: join(home, 'logs', 'kernel.log'),
  };
}
