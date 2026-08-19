import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { isPortOpen, waitForHealthy } from '../lib/health.js';
import { resolvePaths } from '../lib/paths.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  spawnKernelDetached,
  writePidFile,
} from '../lib/process.js';

export interface StartOptions {
  /** Health-check timeout; defaults to PREVIOUSLY_HEALTH_TIMEOUT_MS env or 30s. */
  healthTimeoutMs?: number;
}

/**
 * `previously start` — daemonize the kernel standalone build and wait for it
 * to answer on its port. Fails honestly (per the design's failure philosophy)
 * when the artifact is missing or the port is taken.
 */
export async function run(args: string[], opts: StartOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const config = loadConfig(paths);

  const existingPid = readPidFile(paths.pidPath);
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      console.error(`Previously kernel is already running (pid ${existingPid}).`);
      return 1;
    }
    // Stale pid file from a crashed/killed kernel — clean it up and proceed.
    removePidFile(paths.pidPath);
  }

  const kernelDir = config.kernelDir ?? paths.kernelDir;
  const serverJs = join(kernelDir, 'server.js');
  if (!existsSync(serverJs)) {
    console.error(`Kernel artifact not found: ${serverJs}`);
    console.error('');
    console.error('The Previously kernel is the standalone build produced by the agent repo.');
    console.error(`Place it (including server.js) in ${kernelDir}, or set "kernelDir" in`);
    console.error(`${paths.configPath} to point at it.`);
    return 1;
  }

  if (await isPortOpen(config.port, config.hostname)) {
    console.error(`Cannot start kernel: ${config.hostname}:${config.port} is already in use by another process.`);
    console.error(`Free the port or set a different "port" in ${paths.configPath}.`);
    return 1;
  }

  mkdirSync(paths.logsDir, { recursive: true });
  const pid = spawnKernelDetached({
    serverJs,
    cwd: kernelDir,
    logPath: paths.kernelLogPath,
    env: {
      PREVIOUSLY_MODE: 'client',
      STORAGE: 'local',
      MEMORY_ROOT: config.memoryRoot,
      WORKFLOW_TARGET_WORLD: 'local',
      PORT: String(config.port),
      HOSTNAME: config.hostname,
    },
  });
  writePidFile(paths.pidPath, pid);

  const timeoutMs =
    opts.healthTimeoutMs ?? Number(process.env.PREVIOUSLY_HEALTH_TIMEOUT_MS ?? 30_000);
  const url = `http://${config.hostname}:${config.port}`;
  if (!(await waitForHealthy(url, timeoutMs))) {
    console.error(`Kernel (pid ${pid}) did not respond at ${url} within ${timeoutMs}ms.`);
    console.error(`Check the kernel log: ${paths.kernelLogPath}`);
    console.error(`The process was left running; use \`previously stop\` to kill it.`);
    return 1;
  }

  console.log(`Previously kernel is running at ${url} (pid ${pid})`);
  console.log(`Logs: ${paths.kernelLogPath}`);
  return 0;
}
