import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved on-disk layout of the Previously client home directory.
 *
 * All paths root at PREVIOUSLY_HOME when that env var is set (this is how
 * tests and sandboxed runs avoid touching the real user home); otherwise
 * they root at `~/.previously`.
 */
export interface PreviouslyPaths {
  home: string;
  memoryDir: string;
  /** Kernel task data root (TASKS_ROOT) — outside the versioned kernel dir. */
  tasksDir: string;
  /** Kernel session data root (SESSIONS_ROOT) — outside the versioned kernel dir. */
  sessionsDir: string;
  /** Workflow Local World data root (WORKFLOW_LOCAL_DATA_DIR). */
  workflowDataDir: string;
  /** Extra skills discovery dir (PREVIOUSLY_SKILLS_DIR). */
  skillsDir: string;
  kernelDir: string;
  /** Versioned kernel installs live here: <kernelVersionsDir>/<version>/ */
  kernelVersionsDir: string;
  /** JSON pointer to the active kernel version: { version, dir } */
  kernelCurrentPath: string;
  /** Scratch dir for the shallow clone of the agent repo during kernel install. */
  agentRepoCacheDir: string;
  logsDir: string;
  configPath: string;
  pidPath: string;
  kernelLogPath: string;
  /** Scribe state root: cursors, per-session event state, status. */
  scribeDir: string;
  scribeCursorsPath: string;
  scribeSessionsDir: string;
  scribeStatusPath: string;
  scribePidPath: string;
  scribeLogPath: string;
}

export function resolvePaths(): PreviouslyPaths {
  const home = process.env.PREVIOUSLY_HOME ?? join(homedir(), '.previously');
  const kernelDir = join(home, 'kernel');
  return {
    home,
    memoryDir: join(home, 'memory'),
    tasksDir: join(home, 'tasks'),
    sessionsDir: join(home, 'sessions'),
    workflowDataDir: join(home, '.workflow-data'),
    skillsDir: join(home, 'skills'),
    kernelDir,
    kernelVersionsDir: join(kernelDir, 'versions'),
    kernelCurrentPath: join(kernelDir, 'current.json'),
    agentRepoCacheDir: join(home, 'cache', 'agent-repo'),
    logsDir: join(home, 'logs'),
    configPath: join(home, 'config.json'),
    pidPath: join(home, 'kernel.pid'),
    kernelLogPath: join(home, 'logs', 'kernel.log'),
    scribeDir: join(home, 'scribe'),
    scribeCursorsPath: join(home, 'scribe', 'cursors.json'),
    scribeSessionsDir: join(home, 'scribe', 'sessions'),
    scribeStatusPath: join(home, 'scribe', 'status.json'),
    scribePidPath: join(home, 'scribe.pid'),
    scribeLogPath: join(home, 'logs', 'scribe.log'),
  };
}

/**
 * The default location of the memory git repository, following platform
 * conventions: `<Documents>/Previously` when the user's Documents folder
 * exists, otherwise `<home>/Previously`. Never a hidden/cache directory.
 *
 * Under PREVIOUSLY_HOME (tests, sandboxed runs) the default stays inside the
 * sandbox as `<PREVIOUSLY_HOME>/memory` — the seam mirrors resolvePaths, and
 * `homeDir` is injectable for tests of the platform rule itself.
 */
export function defaultMemoryRepo(homeDir: string = homedir()): string {
  const sandbox = process.env.PREVIOUSLY_HOME;
  if (sandbox !== undefined) return join(sandbox, 'memory');
  const documents = join(homeDir, 'Documents');
  return join(existsSync(documents) ? documents : homeDir, 'Previously');
}
