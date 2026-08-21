import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_AGENTS, checkCliPresence, type BridgeAgent } from '../bridge/index.js';
import { loadConfig, type PreviouslyConfig } from './config.js';
import { isPortOpen } from './health.js';
import { resolveKernel } from './kernel.js';
import { resolvePaths, type PreviouslyPaths } from './paths.js';
import { isProcessAlive, readPidFile } from './process.js';
import { checkCompat, type CompatResult } from './version-policy.js';
import { readScribeStatus, type ScribeStatus } from '../scribe/status.js';

/**
 * Single source of truth for "how is the local Previously doing" — the
 * aggregation behind `previously status`.
 */

export interface BridgePresence {
  agent: BridgeAgent;
  found: boolean;
  detail: string;
}

export interface TodayStats {
  /** Slice directories dated today under the memory root; null when unknown. */
  sliceCount: number | null;
  /** Most recent scribe event timestamp across sources, if any. */
  lastEventAt: string | null;
}

export interface SystemStatus {
  paths: PreviouslyPaths;
  config: PreviouslyConfig;
  /** config.json exists — the system has been through setup. */
  initialized: boolean;
  kernelPid: number | null;
  kernelAlive: boolean;
  reachable: boolean;
  kernelVersion: string | null;
  kernelSource: 'config-override' | 'pointer' | 'default';
  /** The resolved kernel directory (config override / pointer / legacy default). */
  kernelDir: string;
  /** Null when no kernel version is known (nothing to check against). */
  compat: CompatResult | null;
  scribePid: number | null;
  scribeAlive: boolean;
  scribeStatus: ScribeStatus | null;
  bridges: BridgePresence[];
  today: TodayStats;
}

/** Count today's slice directories (episodic/slices/YYYY/MM/DD/HHMM). */
function countTodaySlices(memoryRoot: string, now: Date = new Date()): number | null {
  const dayDir = join(
    memoryRoot,
    'episodic',
    'slices',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  if (!existsSync(dayDir)) return 0;
  try {
    return readdirSync(dayDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return null;
  }
}

export async function collectStatus(paths: PreviouslyPaths = resolvePaths()): Promise<SystemStatus> {
  const config = loadConfig(paths);
  const kernelPid = readPidFile(paths.pidPath);
  const kernelAlive = kernelPid !== null && isProcessAlive(kernelPid);
  const reachable = await isPortOpen(config.port, config.hostname, 1_500);
  const kernel = resolveKernel(config.kernelDir, paths);
  const compat = kernel.version !== null ? checkCompat(kernel.version) : null;

  const scribePid = readPidFile(paths.scribePidPath);
  const scribeAlive = scribePid !== null && isProcessAlive(scribePid);
  const scribeStatus = readScribeStatus(paths.scribeStatusPath);

  const lastEventAt =
    scribeStatus === null
      ? null
      : Object.values(scribeStatus.sources)
          .map((s) => s.lastEventAt)
          .filter((t): t is string => t !== null)
          .sort()
          .at(-1) ?? null;

  return {
    paths,
    config,
    initialized: existsSync(paths.configPath),
    kernelPid,
    kernelAlive,
    reachable,
    kernelVersion: kernel.version,
    kernelSource: kernel.source,
    kernelDir: kernel.dir,
    compat,
    scribePid,
    scribeAlive,
    scribeStatus,
    bridges: BRIDGE_AGENTS.map((agent) => {
      const presence = checkCliPresence(agent);
      return { agent, found: presence.found, detail: presence.detail };
    }),
    today: { sliceCount: countTodaySlices(config.memoryRoot), lastEventAt },
  };
}

/**
 * One honest next-step hint for the end of `previously status` output.
 * Null when everything is healthy.
 */
export function nextStepSuggestion(s: SystemStatus): string | null {
  if (!s.initialized) return 'run `previously init` to create the layout and a default config';
  if (!s.kernelAlive) return 'run `previously` to start';
  if (s.kernelAlive && !s.scribeAlive) return 'run `previously stop && previously` to restart (scribe is dead)';
  if (s.compat !== null && !s.compat.ok) return 'upgrade the client — the installed kernel is outside the supported version line';
  return null;
}
