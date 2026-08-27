import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { parseMsEnv } from '../lib/env.js';
import { applyAudit, auditConfig, auditMemoryRepo } from '../lib/config-doctor.js';
import { isPortOpen, waitForHealthy } from '../lib/health.js';
import { buildKernelEnv } from '../lib/kernel-env.js';
import { resolveKernel } from '../lib/kernel.js';
import { migrateKernelDataDirs } from '../lib/migrate-data-dirs.js';
import { resolvePaths } from '../lib/paths.js';
import { checkCompat } from '../lib/version-policy.js';
import { bold, cmd, emph, err as errText, green, info, muted, ok, printBoxed, warn } from '../lib/ansi.js';
import { run as initRun, type InitOptions } from './init.js';
import {
  checkPidFile,
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
    console.log(info('Previously is not initialized yet — running init first.'));
    const code = await (opts.initFn ?? initRun)([], {});
    if (code !== 0) {
      console.error(errText('Initialization failed — cannot start.'));
      return code;
    }
  }

  const audit = auditConfig(paths);
  if (audit.repairs.length > 0) {
    for (const repair of audit.repairs) console.log(`  ${green('repaired:')} ${repair}`);
    applyAudit(paths, audit);
  }

  const config = loadConfig(paths);

  // The memory root must be a usable git repository before the kernel starts
  // writing to it: missing/Previously-content dirs are repaired, foreign
  // non-empty dirs only warn (never auto-touched) and never block startup.
  const repoAudit = await auditMemoryRepo(config.memoryRoot);
  for (const repair of repoAudit.repairs) console.log(`  ${green('repaired:')} ${repair}`);
  for (const warning of repoAudit.warnings) console.error(warn(warning));

  const existingKernel = checkPidFile(paths.pidPath);
  if (existingKernel.status === 'running') {
    console.error(errText(`Previously kernel is already running (pid ${existingKernel.pid}).`));
    return 1;
  }
  if (existingKernel.status === 'foreign') {
    // The pid from a crashed kernel was reused by an unrelated process.
    console.log(info(`Kernel pid file pointed at an unrelated process (pid ${existingKernel.pid}) — removing it.`));
  }
  if (existingKernel.status !== 'none') {
    // Stale pid file from a crashed/killed kernel — clean it up and proceed.
    removePidFile(paths.pidPath);
  }

  // Kernel dir resolution: explicit config kernelDir wins; otherwise the
  // current-version pointer; otherwise the legacy default dir (C1 flow).
  const kernel = resolveKernel(config.kernelDir, paths);
  if (kernel.version !== null) {
    const compat = checkCompat(kernel.version);
    if (!compat.ok) {
      console.error(errText(compat.message!));
      return 1;
    }
  }
  const kernelDir = kernel.dir;
  const serverJs = join(kernelDir, 'server.js');
  if (!existsSync(serverJs)) {
    console.error(errText(`Kernel artifact not found: ${serverJs}`));
    console.error('');
    console.error('The Previously kernel is the standalone build produced by the agent repo.');
    console.error(`Install one with ${cmd('`previously kernel install`')} (builds the pinned version from source),`);
    console.error(`or place a standalone build (including server.js) in ${emph(paths.kernelDir)},`);
    console.error(`or set "kernelDir" in ${emph(paths.configPath)} to point at one.`);
    return 1;
  }

  if (await isPortOpen(config.port, config.hostname)) {
    console.error(errText(`Cannot start kernel: ${config.hostname}:${config.port} is already in use by another process.`));
    console.error(`Free the port or set a different "port" in ${emph(paths.configPath)}.`);
    return 1;
  }

  // One-time migration: kernel-owned data dirs (tasks/, sessions/,
  // .workflow-data/) used to land inside the (versioned) kernel dir because
  // the kernel runs with cwd=kernelDir. They now live under PREVIOUSLY_HOME
  // via env roots, so move any stranded copies out before launching. Failures
  // warn but never block startup.
  const migration = migrateKernelDataDirs(kernelDir, paths);
  for (const name of migration.moved) {
    console.log(info(`Migrated ${name}/ out of the kernel directory to ${emph(join(paths.home, name))}.`));
  }
  for (const name of migration.keptBoth) {
    console.log(info(`${name}/ exists both in the kernel directory and in ${emph(paths.home)} — keeping both (remove the kernel copy manually if unwanted).`));
  }
  for (const failure of migration.failed) {
    console.error(warn(`Could not migrate ${failure.name}/ out of the kernel directory (${failure.message}); the data stays at ${emph(join(kernelDir, failure.name))}.`));
  }

  mkdirSync(paths.logsDir, { recursive: true });
  const pid = spawnKernelDetached({
    serverJs,
    cwd: kernelDir,
    logPath: paths.kernelLogPath,
    env: buildKernelEnv(config, paths),
  });
  writePidFile(paths.pidPath, pid, serverJs);

  const timeoutMs =
    opts.healthTimeoutMs ?? parseMsEnv('PREVIOUSLY_HEALTH_TIMEOUT_MS', 30_000);
  const url = `http://${config.hostname}:${config.port}`;
  if (!(await waitForHealthy(url, timeoutMs))) {
    console.error(errText(`Kernel (pid ${pid}) did not respond at ${url} within ${timeoutMs}ms.`));
    console.error(`Check the kernel log: ${emph(paths.kernelLogPath)}`);
    console.error(`The process was left running; use ${cmd('`previously stop`')} to kill it.`);
    return 1;
  }

  const report: string[] = [];
  report.push(ok(`Previously kernel is running at ${emph(url)} (pid ${pid})`));
  report.push(`${bold('Logs:')} ${emph(paths.kernelLogPath)}`);

  // The scribe auto-starts as a second detached process (design doc §2/§3).
  // Its failure must never block or roll back the kernel: warn and continue.
  if (opts.startScribe ?? true) {
    const existingScribe = checkPidFile(paths.scribePidPath);
    if (existingScribe.status === 'running') {
      report.push(ok(`Scribe is already running (pid ${existingScribe.pid})`));
    } else {
      if (existingScribe.status !== 'none') removePidFile(paths.scribePidPath);
      try {
        const entry = opts.scribeEntry ?? fileURLToPath(new URL('../cli.js', import.meta.url));
        const scribePid2 = spawnScribeDetached({ cliEntry: entry, logPath: paths.scribeLogPath });
        writePidFile(paths.scribePidPath, scribePid2, `${basename(entry)} watch`);
        report.push(ok(`Scribe is running (pid ${scribePid2})`));
        report.push(`${bold('Logs:')} ${emph(paths.scribeLogPath)}`);
      } catch (err) {
        console.error(warn(`scribe failed to start (${err instanceof Error ? err.message : err}); the kernel is unaffected.`));
        console.error(`Run ${cmd('`previously watch`')} in the foreground to see the error, or retry with ${cmd('`previously start`')}.`);
      }
    }
  }
  printBoxed(report, { tone: 'green', pad: true });
  return 0;
}