import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePaths, type PreviouslyPaths } from './paths.js';

export interface PreviouslyConfig {
  storage: 'local';
  memoryRoot: string;
  /**
   * Explicit kernel dir override. When unset, the kernel resolves via the
   * current-version pointer (~/.previously/kernel/current.json), falling back
   * to the legacy default ~/.previously/kernel.
   */
  kernelDir?: string;
  port: number;
  hostname: string;
  /**
   * Execution backend selection: a subscription bridge CLI (claude|codex|kimi,
   * used as bridge-exec's default agent) or 'api-key' (kernel's own catalog).
   * Set via `previously init --backend`; null means unset.
   */
  executionBackend: string | null;
}

export const DEFAULT_PORT = 3210;
export const DEFAULT_HOSTNAME = '127.0.0.1';

export function defaultConfig(paths: PreviouslyPaths = resolvePaths()): PreviouslyConfig {
  return {
    storage: 'local',
    memoryRoot: paths.memoryDir,
    port: DEFAULT_PORT,
    hostname: DEFAULT_HOSTNAME,
    executionBackend: null,
  };
}

/**
 * Load config.json, merged over defaults so missing fields always have values.
 * Returns pure defaults when no config file exists.
 */
export function loadConfig(paths: PreviouslyPaths = resolvePaths()): PreviouslyConfig {
  const defaults = defaultConfig(paths);
  if (!existsSync(paths.configPath)) return defaults;
  const raw = JSON.parse(readFileSync(paths.configPath, 'utf8')) as Partial<PreviouslyConfig>;
  return { ...defaults, ...raw };
}

export function saveConfig(config: PreviouslyConfig, paths: PreviouslyPaths = resolvePaths()): void {
  mkdirSync(dirname(paths.configPath), { recursive: true });
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
