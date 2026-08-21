import { getKernelLine } from '../lib/version-policy.js';
import { collectStatus, nextStepSuggestion, type SystemStatus } from '../lib/system-status.js';
import { resolvePaths } from '../lib/paths.js';
import type { ScribeStatus } from '../scribe/status.js';
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
 * version/compatibility, bridge CLI presence, scribe health, and a config
 * summary. Exit code reflects the worst subsystem honestly (§9): 0 only when
 * the kernel is running AND reachable AND version-compatible AND the scribe
 * is alive alongside it with no recorded errors.
 *
 * All aggregation lives in lib/system-status.ts (collectStatus).
 */
export async function run(args: string[]): Promise<number> {
  void args;
  const s: SystemStatus = await collectStatus(resolvePaths());
  const { paths, config } = s;

  console.log(`Home:      ${paths.home}`);
  console.log(
    `Config:    ${s.initialized ? paths.configPath : '(not created — run `previously init`)'}`,
  );
  console.log(`Kernel:    ${s.kernelAlive ? `running (pid ${s.kernelPid})` : 'not running'}`);
  if (s.kernelVersion !== null) {
    console.log(
      `Version:   ${s.kernelVersion} (line ${getKernelLine()}.x — ${s.compat!.ok ? 'compatible' : 'INCOMPATIBLE'}, source: ${s.kernelSource})`,
    );
  } else {
    console.log(`Version:   unknown (no installed kernel pointer; dir: ${s.kernelDir})`);
  }
  console.log(`Port:      ${config.hostname}:${config.port} ${s.reachable ? 'reachable' : 'unreachable'}`);
  console.log(`Storage:   ${config.storage} (memory root: ${config.memoryRoot})`);
  console.log(`Backend:   ${config.executionBackend ?? '(unset)'}`);
  for (const bridge of s.bridges) {
    console.log(
      `  bridge ${bridge.agent}: ${bridge.found ? `found (${bridge.detail})` : `not found — ${bridge.detail}`}`,
    );
  }

  console.log(`Scribe:    ${s.scribeAlive ? `running (pid ${s.scribePid})` : 'not running'}`);
  for (const source of SCRIBE_SOURCES) {
    console.log(formatScribeSource(source, s.scribeStatus));
  }
  if (s.scribePid !== null && !s.scribeAlive) {
    console.log(`Note:      stale scribe pid file at ${paths.scribePidPath} (pid ${s.scribePid} is not running)`);
  }
  if (s.scribeStatus !== null && s.scribeStatus.errors.length > 0) {
    const last = s.scribeStatus.errors[s.scribeStatus.errors.length - 1]!;
    console.log(`Scribe errors: ${s.scribeStatus.errors.length} recent (latest: ${last.file}: ${last.message})`);
  }

  if (s.kernelPid !== null && !s.kernelAlive) {
    console.log(`Note:      stale pid file at ${paths.pidPath} (pid ${s.kernelPid} is not running)`);
  }

  const suggestion = nextStepSuggestion(s);
  if (suggestion !== null) console.log(`Next:      ${suggestion}`);

  if (s.compat && !s.compat.ok) {
    console.error(s.compat.message);
    return 1;
  }

  if (!(s.kernelAlive && s.reachable)) return 1;

  // Kernel healthy; the scribe is part of a healthy `start`ed system (§2/§3):
  // a dead scribe beside a live kernel, or recorded scribe errors, is a
  // degraded system and must not report success.
  if (!s.scribeAlive) {
    console.error('Scribe is not running while the kernel is — degraded. Restart with `previously stop && previously start`.');
    return 1;
  }
  if (s.scribeStatus !== null && s.scribeStatus.errors.length > 0) {
    console.error(`Scribe has ${s.scribeStatus.errors.length} recorded error(s) — degraded. See \`previously logs\` and the status file.`);
    return 1;
  }
  return 0;
}
