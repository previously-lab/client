import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run as init } from '../src/commands/init.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

describe('init', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('creates the directory layout and default config', async () => {
    home = useTempHome();
    expect(await init([])).toBe(0);
    const paths = resolvePaths();
    for (const dir of [paths.home, paths.memoryDir, paths.kernelDir, paths.logsDir]) {
      expect(existsSync(dir), dir).toBe(true);
    }
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config).toMatchObject({
      storage: 'local',
      memoryRoot: join(home, 'memory'),
      port: 3210,
      hostname: '127.0.0.1',
      executionBackend: null,
    });
  });

  it('is idempotent: a second run keeps an existing config untouched', async () => {
    home = useTempHome();
    expect(await init([])).toBe(0);
    const paths = resolvePaths();
    // User edits the config afterwards.
    const edited = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    edited.port = 9999;
    edited.customField = 'keep-me';
    writeFileSync(paths.configPath, JSON.stringify(edited), 'utf8');

    expect(await init([])).toBe(0);
    const after = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(after.port).toBe(9999);
    expect(after.customField).toBe('keep-me');
  });

  it('--force overwrites an existing config with defaults', async () => {
    home = useTempHome();
    expect(await init([])).toBe(0);
    const paths = resolvePaths();
    writeFileSync(paths.configPath, JSON.stringify({ port: 9999 }), 'utf8');

    expect(await init(['--force'])).toBe(0);
    const after = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(after.port).toBe(3210);
  });
});
