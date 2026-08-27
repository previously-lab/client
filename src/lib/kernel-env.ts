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
 * PREVIOUSLY_HOME and PREVIOUSLY_BRIDGE_CMD; those are unchanged. The
 * TASKS_ROOT / SESSIONS_ROOT / WORKFLOW_LOCAL_DATA_DIR /
 * PREVIOUSLY_SKILLS_DIR keys keep kernel data outside the versioned kernel
 * directory so kernel upgrades don't strand it.
 *
 * PREVIOUSLY_BRIDGE_CMD is the REGISTERED command name: the client is an
 * installed application, and the kernel invokes it the same way the user
 * does — `previously …`. Shim resolution (Windows .cmd shims cannot be
 * spawned shell-less) is the KERNEL's job — its bridge spawn resolves bare
 * command names against PATH and routes .cmd/.bat through cmd.exe (same
 * treatment as this repo's own bridge runner).
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
    TASKS_ROOT: paths.tasksDir,
    SESSIONS_ROOT: paths.sessionsDir,
    WORKFLOW_LOCAL_DATA_DIR: paths.workflowDataDir,
    PREVIOUSLY_SKILLS_DIR: paths.skillsDir,
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
