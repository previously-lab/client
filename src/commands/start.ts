import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { applyAudit, auditConfig } from '../lib/config-doctor.js';
import { isPortOpen, waitForHealthy } from '../lib/health.js';
import { buildKernelEnv } from '../lib/kernel-env.js';
import { resolveKernel } from '../lib/kernel.js';
import { resolvePaths } from '../lib/paths.js';
import { checkCompat } from '../lib/version-policy.js';
import { run as initRun, type InitOptions } from './init.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  spawnKernelDetached,
  spawnScribeDetached,
  writePidFile,
} from '../lib/process.js';

export interface StartOptions {
  /** Health-check timeout; defaults to PREVIOUSLY_HEALTH_TIMEOUT_MS env or 30s. */
  healthTimeoutMs?: number;
  /** Auto-start the scribe alongside the kernel (default true; tests opt out). */
  startScribe?: boolean;
  /** Test hook: scribe entry script override (defaults to this build's cli.js). */
  scribeEntry?: string;
  /** Test hook: init delegation when config.json is missing. */
  initFn?: (args: string[], opts?: InitOptions) => Promise<number>;
}

/**
 * `previously start` — daemonize the kernel standalone build and wait for it
 * to answer on its port. Fails honestly (per the design's failure philosophy)
 * when the artifact is missing or the port is taken.
 *
 * Dependencies are enforced, not assumed: with no config.json, start first
 * delegates to init (wizard on a TTY, non-interactive defaults otherwise);
 * every start then runs the config doctor so the kernel never launches with
 * a broken config.
 */
export async function run(args: string[], opts: StartOptions = {}): Promise<number> {
  void args;
  const paths = resolvePaths();

  if (!existsSync(paths.configPath)) {
    console.log('Previously is not initialized yet — running init first.');
    const code = await (opts.initFn ?? initRun)([], {});
    if (code !== 0) {
      console.error('Initialization failed — cannot start.');
      return code;
    }
  }

  const audit = auditConfig(paths);
  if (audit.repairs.length > 0) {
    for (const repair of audit.repairs) console.log(`  repaired: ${repair}`);
    applyAudit(paths, audit);
  }

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

  // Kernel dir resolution: explicit config kernelDir wins; otherwise the
  // current-version pointer; otherwise the legacy default dir (C1 flow).
  const kernel = resolveKernel(config.kernelDir, paths);
  if (kernel.version !== null) {
    const compat = checkCompat(kernel.version);
    if (!compat.ok) {
      console.error(compat.message);
      return 1;
    }
  }
  const kernelDir = kernel.dir;
  const serverJs = join(kernelDir, 'server.js');
  if (!existsSync(serverJs)) {
    console.error(`Kernel artifact not found: ${serverJs}`);
    console.error('');
    console.error('The Previously kernel is the standalone build produced by the agent repo.');
    console.error('Install one with `previously kernel install --ref <ref>` (builds from source),');
    console.error(`or place a standalone build (including server.js) in ${paths.kernelDir},`);
    console.error(`or set "kernelDir" in ${paths.configPath} to point at one.`);
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
    env: buildKernelEnv(config, paths),
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

  // The scribe auto-starts as a second detached process (design doc §2/§3).
  // Its failure must never block or roll back the kernel: warn and continue.
  if (opts.startScribe ?? true) {
    const scribePid = readPidFile(paths.scribePidPath);
    if (scribePid !== null && isProcessAlive(scribePid)) {
      console.log(`Scribe is already running (pid ${scribePid})`);
    } else {
      if (scribePid !== null) removePidFile(paths.scribePidPath);
      try {
        const entry = opts.scribeEntry ?? fileURLToPath(new URL('../cli.js', import.meta.url));
        const scribePid2 = spawnScribeDetached({ cliEntry: entry, logPath: paths.scribeLogPath });
        writePidFile(paths.scribePidPath, scribePid2);
        console.log(`Scribe is running (pid ${scribePid2})`);
        console.log(`Logs: ${paths.scribeLogPath}`);
      } catch (err) {
        console.error(`Warning: scribe failed to start (${err instanceof Error ? err.message : err}); the kernel is unaffected.`);
        console.error('Run `previously watch` in the foreground to see the error, or retry with `previously start`.');
      }
    }
  }
  return 0;
}
