import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { isPortOpen } from '../lib/health.js';
import { resolveKernel } from '../lib/kernel.js';
import { resolvePaths } from '../lib/paths.js';
import { isProcessAlive, readPidFile } from '../lib/process.js';
import { checkCompat, getKernelLine } from '../lib/version-policy.js';
import { readScribeStatus, type ScribeStatus } from '../scribe/status.js';
import { SCRIBE_SOURCES, type ScribeSource } from '../scribe/types.js';

function formatScribeSource(source: ScribeSource, status: ScribeStatus | null): string {
  const s = status?.sources[source];
  if (s === undefined) return `  ${source}: (no status yet)`;
  if (!s.rootPresent) return `  ${source}: root absent (${s.root})`;
  const last = s.lastEventAt ?? '—';
  return `  ${source}: ${s.filesProcessed}/${s.filesSeen} files, ${s.events} events, ${s.parseErrors} parse errors, last event ${last}`;
}

/**
 * `previously status` — report kernel liveness, port reachability, kernel
 * version/compatibility, and a config summary. Exit code 0 only when the
 * kernel is running AND reachable AND version-compatible.
 */
export async function run(args: string[]): Promise<number> {
  void args;
  const paths = resolvePaths();
  const config = loadConfig(paths);

  const pid = readPidFile(paths.pidPath);
  const alive = pid !== null && isProcessAlive(pid);
  const reachable = await isPortOpen(config.port, config.hostname, 1_500);

  const kernel = resolveKernel(config.kernelDir, paths);
  const compat = kernel.version !== null ? checkCompat(kernel.version) : null;

  console.log(`Home:      ${paths.home}`);
  console.log(
    `Config:    ${existsSync(paths.configPath) ? paths.configPath : '(not created — run `previously init`)'}`,
  );
  console.log(`Kernel:    ${alive ? `running (pid ${pid})` : 'not running'}`);
  if (kernel.version !== null) {
    console.log(
      `Version:   ${kernel.version} (line ${getKernelLine()}.x — ${compat!.ok ? 'compatible' : 'INCOMPATIBLE'}, source: ${kernel.source})`,
    );
  } else {
    console.log(`Version:   unknown (no installed kernel pointer; dir: ${kernel.dir})`);
  }
  console.log(`Port:      ${config.hostname}:${config.port} ${reachable ? 'reachable' : 'unreachable'}`);
  console.log(`Storage:   ${config.storage} (memory root: ${config.memoryRoot})`);
  console.log(`Backend:   ${config.executionBackend ?? '(unset)'}`);

  const scribePid = readPidFile(paths.scribePidPath);
  const scribeAlive = scribePid !== null && isProcessAlive(scribePid);
  const scribeStatus = readScribeStatus(paths.scribeStatusPath);
  console.log(`Scribe:    ${scribeAlive ? `running (pid ${scribePid})` : 'not running'}`);
  for (const source of SCRIBE_SOURCES) {
    console.log(formatScribeSource(source, scribeStatus));
  }
  if (scribePid !== null && !scribeAlive) {
    console.log(`Note:      stale scribe pid file at ${paths.scribePidPath} (pid ${scribePid} is not running)`);
  }
  if (scribeStatus !== null && scribeStatus.errors.length > 0) {
    const last = scribeStatus.errors[scribeStatus.errors.length - 1]!;
    console.log(`Scribe errors: ${scribeStatus.errors.length} recent (latest: ${last.file}: ${last.message})`);
  }

  if (pid !== null && !alive) {
    console.log(`Note:      stale pid file at ${paths.pidPath} (pid ${pid} is not running)`);
  }
  if (compat && !compat.ok) {
    console.error(compat.message);
    return 1;
  }

  return alive && reachable ? 0 : 1;
}
