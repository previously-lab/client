import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

describe('paths', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('roots everything at PREVIOUSLY_HOME when set', () => {
    home = useTempHome();
    const paths = resolvePaths();
    expect(paths.home).toBe(home);
    expect(paths.memoryDir).toBe(join(home, 'memory'));
    expect(paths.tasksDir).toBe(join(home, 'tasks'));
    expect(paths.sessionsDir).toBe(join(home, 'sessions'));
    expect(paths.workflowDataDir).toBe(join(home, '.workflow-data'));
    expect(paths.skillsDir).toBe(join(home, 'skills'));
    expect(paths.kernelDir).toBe(join(home, 'kernel'));
    expect(paths.logsDir).toBe(join(home, 'logs'));
    expect(paths.configPath).toBe(join(home, 'config.json'));
    expect(paths.pidPath).toBe(join(home, 'kernel.pid'));
    expect(paths.kernelLogPath).toBe(join(home, 'logs', 'kernel.log'));
  });

  it('defaults to ~/.previously when PREVIOUSLY_HOME is unset', () => {
    // useTempHome only for afterEach symmetry; the env var must be absent here.
    home = join(homedir(), '.previously'); // not created on disk, just the expected value
    delete process.env.PREVIOUSLY_HOME;
    expect(resolvePaths().home).toBe(join(homedir(), '.previously'));
  });
});
