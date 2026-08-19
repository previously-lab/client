import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { isPortOpen } from '../lib/health.js';
import { resolvePaths } from '../lib/paths.js';
import { isProcessAlive, readPidFile } from '../lib/process.js';

/**
 * `previously status` — report kernel liveness, port reachability, and a
 * config summary. Exit code 0 only when the kernel is running AND reachable.
 */
export async function run(args: string[]): Promise<number> {
  void args;
  const paths = resolvePaths();
  const config = loadConfig(paths);

  const pid = readPidFile(paths.pidPath);
  const alive = pid !== null && isProcessAlive(pid);
  const reachable = await isPortOpen(config.port, config.hostname, 1_500);

  console.log(`Home:      ${paths.home}`);
  console.log(
    `Config:    ${existsSync(paths.configPath) ? paths.configPath : '(not created — run `previously init`)'}`,
  );
  console.log(`Kernel:    ${alive ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Port:      ${config.hostname}:${config.port} ${reachable ? 'reachable' : 'unreachable'}`);
  console.log(`Storage:   ${config.storage} (memory root: ${config.memoryRoot})`);
  console.log(`Backend:   ${config.executionBackend ?? '(unset)'}`);
  if (pid !== null && !alive) {
    console.log(`Note:      stale pid file at ${paths.pidPath} (pid ${pid} is not running)`);
  }

  return alive && reachable ? 0 : 1;
}
