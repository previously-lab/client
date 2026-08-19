import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePaths, type PreviouslyPaths } from './paths.js';

export interface PreviouslyConfig {
  storage: 'local';
  memoryRoot: string;
  /** Directory containing the kernel standalone build (server.js). Default: ~/.previously/kernel */
  kernelDir?: string;
  port: number;
  hostname: string;
  /** Execution backend selection (subscription bridge / API key). Unset in C1. */
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
