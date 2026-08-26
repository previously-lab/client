import type { PreviouslyConfig } from './config.js';
import type { PreviouslyPaths } from './paths.js';

/**
 * The env contract between client and kernel (mirrored by the agent repo —
 * keep strictly in sync). Pure function so tests can assert the exact map.
 * All values flow through the Node.js spawn env only — never shell-level
 * environment variables.
 *
 * Only ever appends to the established keys (PREVIOUSLY_MODE / STORAGE /
 * MEMORY_ROOT / WORKFLOW_TARGET_WORLD / PORT / HOSTNAME) plus
 * PREVIOUSLY_HOME and PREVIOUSLY_BRIDGE_CMD; those are unchanged.
 *
 * PREVIOUSLY_BRIDGE_CMD is the REGISTERED command name, never an absolute
 * path into this checkout's build output: the client is an installed
 * application, and both the kernel and any bridged agent must invoke it the
 * same way the user does — `previously …`. This matches the kernel's own
 * default; the key is set explicitly only to document the contract.
 */
export function buildKernelEnv(
  config: PreviouslyConfig,
  paths: PreviouslyPaths,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PREVIOUSLY_HOME: paths.home,
    PREVIOUSLY_MODE: 'client',
    STORAGE: 'local',
    MEMORY_ROOT: config.memoryRoot,
    WORKFLOW_TARGET_WORLD: 'local',
    PORT: String(config.port),
    HOSTNAME: config.hostname,
    PREVIOUSLY_BRIDGE_CMD: 'previously bridge-exec',
  };

  // Manually-provided API keys from config (plaintext local MVP, see config.ts).
  for (const [name, value] of Object.entries(config.apiKeys ?? {})) {
    env[name] = value;
  }

  const brain = config.brain;
  if (brain?.type === 'bridge') {
    env.PREVIOUSLY_BRAIN = 'bridge';
    env.PREVIOUSLY_BRAIN_AGENT = brain.agent;
  } else if (brain?.type === 'api-key') {
    // Ensure the chosen key reaches the kernel: from apiKeys above, or from
    // the inherited process env (spawnKernelDetached merges process.env — we
    // set it explicitly so the contract holds regardless of spawn merging).
    const value = config.apiKeys?.[brain.env] ?? processEnv[brain.env];
    if (value !== undefined) env[brain.env] = value;
    if (brain.model !== undefined) env.PREVIOUSLY_DEFAULT_MODEL = brain.model;
  }
  return env;
}
