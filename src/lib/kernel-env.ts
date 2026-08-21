import { fileURLToPath } from 'node:url';
import type { PreviouslyConfig } from './config.js';
import type { PreviouslyPaths } from './paths.js';

/**
 * Absolute path to this CLI's entrypoint (dist/cli.js at runtime). The bridge
 * channel between kernel and client is exactly one contract —
 * PREVIOUSLY_BRIDGE_CMD — injected at spawn time as a fully-qualified
 * `node <cli.js> bridge-exec` command: no PATH lookup, no shell-level env
 * vars, and invoking the actual agent CLIs stays the client's job
 * (bridge-exec). If the kernel cannot spawn it, it reports honestly and the
 * user configures manually — no guessing on either side.
 */
const CLI_ENTRY = fileURLToPath(new URL('../cli.js', import.meta.url));

/**
 * The env contract between client and kernel (mirrored by the agent repo —
 * keep strictly in sync). Pure function so tests can assert the exact map.
 * All values flow through the Node.js spawn env only — never shell-level
 * environment variables.
 *
 * Only ever appends to the established keys (PREVIOUSLY_MODE / STORAGE /
 * MEMORY_ROOT / WORKFLOW_TARGET_WORLD / PORT / HOSTNAME) plus
 * PREVIOUSLY_HOME and PREVIOUSLY_BRIDGE_CMD; those are unchanged.
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
    // Quoted segments — the kernel's splitBridgeCommand honors double quotes,
    // and both paths may contain spaces (e.g. "C:\Program Files\nodejs").
    PREVIOUSLY_BRIDGE_CMD: `"${process.execPath}" "${CLI_ENTRY}" bridge-exec`,
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
