import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, defaultConfig, loadConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

describe('config', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('returns defaults when no config file exists', () => {
    home = useTempHome();
    const config = loadConfig();
    expect(config).toEqual({
      storage: 'local',
      memoryRoot: join(home, 'memory'),
      port: DEFAULT_PORT,
      hostname: '127.0.0.1',
      executionBackend: null,
    });
  });

  it('save/load round-trips', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const config = { ...defaultConfig(paths), port: 4321, executionBackend: 'claude-code' };
    saveConfig(config, paths);
    expect(loadConfig(paths)).toEqual(config);
  });

  it('merges a partial config file over defaults', () => {
    home = useTempHome();
    const paths = resolvePaths();
    saveConfig(defaultConfig(paths), paths);
    // Simulate a hand-edited, minimal config file.
    writeFileSync(paths.configPath, JSON.stringify({ port: 9999 }), 'utf8');
    const config = loadConfig(paths);
    expect(config.port).toBe(9999);
    expect(config.storage).toBe('local');
    expect(config.memoryRoot).toBe(paths.memoryDir);
  });

  it('loadConfig never creates the config file as a side effect', () => {
    home = useTempHome();
    loadConfig();
    expect(existsSync(resolvePaths().configPath)).toBe(false);
  });

  it('writes valid, human-readable JSON', () => {
    home = useTempHome();
    const paths = resolvePaths();
    saveConfig(defaultConfig(paths), paths);
    const parsed = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(parsed.port).toBe(DEFAULT_PORT);
  });

  it('round-trips brain and apiKeys (new contract fields)', () => {
    home = useTempHome();
    const paths = resolvePaths();
    const config = {
      ...defaultConfig(paths),
      brain: { type: 'bridge', agent: 'claude' } as const,
      apiKeys: { DEEPSEEK_API_KEY: 'sk-plaintext-mvp' },
    };
    saveConfig(config, paths);
    const loaded = loadConfig(paths);
    expect(loaded.brain).toEqual({ type: 'bridge', agent: 'claude' });
    expect(loaded.apiKeys).toEqual({ DEEPSEEK_API_KEY: 'sk-plaintext-mvp' });
  });

  it('api-key brain with optional model round-trips', () => {
    home = useTempHome();
    const paths = resolvePaths();
    saveConfig(
      { ...defaultConfig(paths), brain: { type: 'api-key', env: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' } },
      paths,
    );
    expect(loadConfig(paths).brain).toEqual({ type: 'api-key', env: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' });
  });

  it('old configs without brain/apiKeys load with both undefined', () => {
    home = useTempHome();
    const paths = resolvePaths();
    writeFileSync(paths.configPath, JSON.stringify({ port: 3210, executionBackend: 'kimi' }), 'utf8');
    const loaded = loadConfig(paths);
    expect(loaded.brain).toBeUndefined();
    expect(loaded.apiKeys).toBeUndefined();
    expect(loaded.executionBackend).toBe('kimi');
  });
});
