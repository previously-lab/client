import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateKernelDataDirs } from '../src/lib/migrate-data-dirs.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

/**
 * The one-time migration that moves kernel-owned data dirs (tasks/,
 * sessions/, .workflow-data/) out of the versioned kernel directory into
 * PREVIOUSLY_HOME. Exercised against real temp dirs; the rename failure case
 * goes through the rename test hook.
 */
describe('migrateKernelDataDirs', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  /** A fake versioned kernel dir with a marker file inside <name>/. */
  function seedKernelData(kernelDir: string, name: string): string {
    const dir = join(kernelDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker.txt'), `kernel copy of ${name}`, 'utf8');
    return dir;
  }

  it('moves stranded data dirs out of the kernel dir into PREVIOUSLY_HOME', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const kernelDir = join(paths.kernelDir, 'versions', '0.9.0');
    for (const name of ['tasks', 'sessions', '.workflow-data']) seedKernelData(kernelDir, name);

    const result = migrateKernelDataDirs(kernelDir, paths);

    expect(result.moved.sort()).toEqual(['.workflow-data', 'sessions', 'tasks']);
    expect(result.keptBoth).toEqual([]);
    expect(result.failed).toEqual([]);
    for (const name of ['tasks', 'sessions', '.workflow-data']) {
      expect(existsSync(join(kernelDir, name)), `${name} source`).toBe(false);
      expect(existsSync(join(home, name, 'marker.txt')), `${name} target`).toBe(true);
    }
  });

  it('does nothing when the kernel dir holds no data dirs', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const kernelDir = join(paths.kernelDir, 'versions', '0.9.0');
    mkdirSync(kernelDir, { recursive: true });

    const result = migrateKernelDataDirs(kernelDir, paths);

    expect(result).toEqual({ moved: [], keptBoth: [], failed: [] });
    expect(existsSync(paths.tasksDir)).toBe(false);
    expect(existsSync(paths.sessionsDir)).toBe(false);
    expect(existsSync(paths.workflowDataDir)).toBe(false);
  });

  it('keeps both sides when the target already exists — never overwrites', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const kernelDir = join(paths.kernelDir, 'versions', '0.9.0');
    seedKernelData(kernelDir, 'tasks');
    mkdirSync(paths.tasksDir, { recursive: true });
    writeFileSync(join(paths.tasksDir, 'marker.txt'), 'home copy of tasks', 'utf8');

    const result = migrateKernelDataDirs(kernelDir, paths);

    expect(result.moved).toEqual([]);
    expect(result.keptBoth).toEqual(['tasks']);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(kernelDir, 'tasks', 'marker.txt'))).toBe(true);
    expect(existsSync(join(paths.tasksDir, 'marker.txt'))).toBe(true);
  });

  it('reports a failed rename (e.g. cross-device) without throwing or touching the source', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const kernelDir = join(paths.kernelDir, 'versions', '0.9.0');
    seedKernelData(kernelDir, 'sessions');
    const failingRename = (() => {
      throw new Error('EXDEV: cross-device link not permitted');
    }) as typeof import('node:fs').renameSync;

    const result = migrateKernelDataDirs(kernelDir, paths, failingRename);

    expect(result.moved).toEqual([]);
    expect(result.keptBoth).toEqual([]);
    expect(result.failed).toEqual([{ name: 'sessions', message: 'EXDEV: cross-device link not permitted' }]);
    expect(existsSync(join(kernelDir, 'sessions', 'marker.txt'))).toBe(true);
    expect(existsSync(paths.sessionsDir)).toBe(false);
  });
});
