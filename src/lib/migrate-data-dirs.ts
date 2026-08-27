import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviouslyPaths } from './paths.js';

/**
 * One-time migration of kernel-owned data directories out of the (versioned)
 * kernel directory into PREVIOUSLY_HOME, so a kernel upgrade to a new version
 * directory doesn't strand them. For each name, if <kernelDir>/<name> exists
 * and <home>/<name> does not, the directory is moved with renameSync. When
 * both sides exist, both are kept (reported, never merged or overwritten);
 * when the move itself fails (e.g. a cross-device rename), the failure is
 * reported and the caller keeps going — startup is never blocked.
 */
export interface DataDirMigration {
  /** Names moved out of the kernel dir. */
  moved: string[];
  /** Names present on both sides — both kept, nothing overwritten. */
  keptBoth: string[];
  /** Names whose move failed — the kernel-dir copy is left untouched. */
  failed: { name: string; message: string }[];
}

export function migrateKernelDataDirs(
  kernelDir: string,
  paths: PreviouslyPaths,
  /** Test hook: rename implementation override. */
  rename: typeof renameSync = renameSync,
): DataDirMigration {
  const targets: Record<string, string> = {
    tasks: paths.tasksDir,
    sessions: paths.sessionsDir,
    '.workflow-data': paths.workflowDataDir,
  };
  const result: DataDirMigration = { moved: [], keptBoth: [], failed: [] };
  for (const [name, target] of Object.entries(targets)) {
    const source = join(kernelDir, name);
    if (!existsSync(source)) continue;
    if (existsSync(target)) {
      result.keptBoth.push(name);
      continue;
    }
    try {
      rename(source, target);
      result.moved.push(name);
    } catch (err) {
      result.failed.push({ name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
