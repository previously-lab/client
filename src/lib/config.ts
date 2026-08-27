import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePaths, type PreviouslyPaths } from './paths.js';

/**
 * Brain (kernel main model) configuration. Contract mirrored by the agent
 * repo — keep strictly in sync:
 * - undefined: current behavior, the kernel relies on keys already in its env.
 * - { type: 'api-key', env, model? }: reuse the env var `env` (value lives in
 *   the process env or in apiKeys below — never duplicated into `brain`).
 * - { type: 'bridge', agent }: pure-subscription mode, an installed agent
 *   CLI acts as the brain.
 */
export type BrainConfig =
  | { type: 'api-key'; env: string; model?: string }
  | { type: 'bridge'; agent: 'claude' | 'codex' | 'kimi' };

/** Reasoning-effort knob shared by the claude and codex CLIs. */
export type AgentEffort = 'low' | 'medium' | 'high';

/**
 * Per-agent tuning for the subscription bridge CLIs (design §7). Absent
 * fields mean "CLI default". Kimi Code exposes no effort knob — its entry
 * honestly carries model only.
 */
export interface AgentsConfig {
  claude?: { model?: string; effort?: AgentEffort };
  codex?: { model?: string; effort?: AgentEffort };
  kimi?: { model?: string };
}

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
  /** Brain selection; absent means "kernel uses whatever keys its env has". */
  brain?: BrainConfig;
  /**
   * Manually entered API keys, keyed by env var name (e.g. DEEPSEEK_API_KEY).
   * Plaintext in config.json is accepted for the local MVP — the file stays
   * under the user's own ~/.previously. start injects each entry into the
   * kernel's environment.
   */
  apiKeys?: Record<string, string>;
  /** Per-agent model/effort tuning for bridge-exec dispatches (§7). */
  agents?: AgentsConfig;
  /**
   * BYOK (bring-your-own-key) engine section, written by the kernel Web UI
   * settings page (POST /api/client/config). The client never reads it; it
   * only has to survive load/save and the config doctor untouched. Its
   * presence means the user deliberately picked the BYOK engine — which is
   * why the doctor must not re-derive a bridge brain (see config-doctor.ts).
   */
  byok?: Record<string, unknown>;
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
  // config.json carries plaintext API keys — owner-only on POSIX (mode only
  // applies at creation, so chmod afterwards to tighten pre-existing files;
  // Windows ACLs ignore this, which is fine).
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(paths.configPath, 0o600);
    } catch {
      // Best-effort hardening; the file contents are still correct.
    }
  }
}

/**
 * Resolve which subscription CLI serves as the local brain for client-side
 * model work (ingest --mark, card bootstrap): an explicit flag wins, else the
 * configured executionBackend. Honest, actionable error when neither yields a
 * bridge agent — these features never touch API keys themselves.
 */
export function resolveBrainAgent(flag: string | undefined, config: PreviouslyConfig): 'claude' | 'codex' | 'kimi' {
  const valid = (v: string): v is 'claude' | 'codex' | 'kimi' => v === 'claude' || v === 'codex' || v === 'kimi';
  if (flag !== undefined) {
    if (valid(flag)) return flag;
    throw new Error(`Unknown --agent value: ${flag} (expected claude|codex|kimi)`);
  }
  const configured = config.executionBackend;
  if (configured !== null && valid(configured)) return configured;
  if (configured !== null) {
    throw new Error(
      `executionBackend is "${configured}", which is not a subscription bridge CLI. ` +
        'Pass --agent claude|codex|kimi, or set a default with `previously init --backend ...`.',
    );
  }
  throw new Error(
    'No bridge agent selected. Pass --agent claude|codex|kimi, or set a default with ' +
      '`previously init --backend claude|codex|kimi`.',
  );
}
