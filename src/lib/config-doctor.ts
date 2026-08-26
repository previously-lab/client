import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { BRIDGE_AGENTS } from '../bridge/types.js';
import { DEFAULT_HOSTNAME, DEFAULT_PORT, defaultConfig, saveConfig, type PreviouslyConfig } from './config.js';
import { resolvePaths, type PreviouslyPaths } from './paths.js';

/**
 * The config doctor. `loadConfig` merges over defaults but never validates —
 * a hand-edited or half-migrated config.json can carry illegal values, and
 * (today's incident) an executionBackend naming a bridge agent with no
 * `brain`, which silently breaks kernel startup env injection.
 *
 * `auditConfig` returns a repaired in-memory config plus one human sentence
 * per repair. Pure: the caller decides whether to persist (saveConfig) and
 * how to report. Idempotent — auditing a repaired config yields no repairs.
 */
export interface ConfigAudit {
  config: PreviouslyConfig;
  repairs: string[];
}

const BACKEND_VALUES: readonly string[] = [...BRIDGE_AGENTS, 'api-key'];

export function isBridgeAgent(value: string): value is 'claude' | 'codex' | 'kimi' {
  return (BRIDGE_AGENTS as readonly string[]).includes(value);
}

/** Selecting a bridge backend implies using it as the brain (subscription mode). */
export function applyBackend(config: PreviouslyConfig, backend: string | null): void {
  config.executionBackend = backend;
  if (backend !== null && isBridgeAgent(backend)) {
    config.brain = { type: 'bridge', agent: backend };
  }
}

/**
 * Validate `raw` (already merged over defaults by the caller or loadConfig)
 * and return a repaired copy. `raw` may carry arbitrary extra/illegal fields
 * from a hand edit, so every field is checked structurally, never trusted.
 */
export function repairConfig(raw: PreviouslyConfig, paths: PreviouslyPaths): ConfigAudit {
  const config: PreviouslyConfig = { ...raw };
  const repairs: string[] = [];
  const defaults = defaultConfig(paths);

  if (config.storage !== 'local') {
    repairs.push(`storage "${String(config.storage)}" is unsupported — reset to "local"`);
    config.storage = 'local';
  }
  if (typeof config.memoryRoot !== 'string' || config.memoryRoot.trim() === '') {
    repairs.push(`memoryRoot missing/empty — reset to ${defaults.memoryRoot}`);
    config.memoryRoot = defaults.memoryRoot;
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    repairs.push(`port "${String(config.port)}" is invalid — reset to ${DEFAULT_PORT}`);
    config.port = DEFAULT_PORT;
  }
  if (typeof config.hostname !== 'string' || config.hostname.trim() === '') {
    repairs.push(`hostname missing/empty — reset to ${DEFAULT_HOSTNAME}`);
    config.hostname = DEFAULT_HOSTNAME;
  }
  if (config.executionBackend !== null && !BACKEND_VALUES.includes(String(config.executionBackend))) {
    repairs.push(`executionBackend "${String(config.executionBackend)}" is unknown — reset to unset`);
    config.executionBackend = null;
  }

  // Brain: structurally validate; a bridge backend without a working brain is
  // repaired by deriving the brain from the backend (the subscription the
  // user already picked).
  const brain = config.brain;
  const brainValid =
    brain !== undefined &&
    ((brain.type === 'bridge' && isBridgeAgent(brain.agent)) ||
      (brain.type === 'api-key' && typeof brain.env === 'string' && brain.env.trim() !== ''));
  if (brain !== undefined && !brainValid) {
    repairs.push('brain is malformed — removed (re-derive from backend below when possible)');
    delete config.brain;
  }
  if (config.brain === undefined && config.executionBackend !== null && isBridgeAgent(config.executionBackend)) {
    repairs.push(`brain missing while backend is "${config.executionBackend}" — set brain to bridge:${config.executionBackend}`);
    config.brain = { type: 'bridge', agent: config.executionBackend };
  }

  if (config.kernelDir !== undefined && (typeof config.kernelDir !== 'string' || config.kernelDir.trim() === '')) {
    repairs.push('kernelDir is not a usable path — removed (pointer/default resolution applies)');
    delete config.kernelDir;
  }
  if (config.apiKeys !== undefined && (typeof config.apiKeys !== 'object' || config.apiKeys === null || Array.isArray(config.apiKeys))) {
    repairs.push('apiKeys is not an object — removed');
    delete config.apiKeys;
  }
  if (config.agents !== undefined) {
    if (typeof config.agents !== 'object' || config.agents === null || Array.isArray(config.agents)) {
      repairs.push('agents is not an object — removed');
      delete config.agents;
    } else {
      for (const key of Object.keys(config.agents)) {
        if (!isBridgeAgent(key)) {
          repairs.push(`agents.${key} is not a known bridge agent — removed`);
          delete (config.agents as Record<string, unknown>)[key];
        }
      }
    }
  }

  return { config, repairs };
}

/** Load config.json and repair it. Does not persist. A file that is not
 * valid JSON at all falls back to defaults with a repair note (the caller's
 * persist step then rewrites it; applyAudit keeps a .bak first). */
export function auditConfig(paths: PreviouslyPaths = resolvePaths()): ConfigAudit {
  if (!existsSync(paths.configPath)) return { config: defaultConfig(paths), repairs: [] };
  let raw: Partial<PreviouslyConfig>;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, 'utf8')) as Partial<PreviouslyConfig>;
  } catch {
    return {
      config: defaultConfig(paths),
      repairs: ['config.json is not valid JSON — rewriting it with defaults (original kept as config.json.bak)'],
    };
  }
  return repairConfig({ ...defaultConfig(paths), ...raw }, paths);
}

/**
 * Persist an audit's repairs: back up the existing file once to
 * config.json.bak, then write the repaired config. No-op when healthy.
 */
export function applyAudit(paths: PreviouslyPaths, audit: ConfigAudit): void {
  if (audit.repairs.length === 0) return;
  if (existsSync(paths.configPath)) {
    copyFileSync(paths.configPath, `${paths.configPath}.bak`);
  }
  saveConfig(audit.config, paths);
}
