import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relPathToSliceId, run as strands, truncateStrandsOutput } from '../src/commands/strands.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('strands command', () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = useTempHome();
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('usage errors exit 2: extra positional, flag-like name', async () => {
    expect(await strands(['a', 'b'])).toBe(2);
    expect(await strands(['--bogus'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('lists every strand with its slice count, sorted by name', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await strands([]);
    expect(code).toBe(0);
    const lines = stdout.join('\n').split('\n');
    expect(lines).toEqual(['面试准备 (1 slice(s))', '项目开发 (2 slice(s))']);
  });

  it('a named strand prints its slice ids, one per line', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await strands(['项目开发']);
    expect(code).toBe(0);
    expect(stdout.join('\n').split('\n')).toEqual(['2026-08-09-1546', '2026-08-10-1700']);
  });

  it('an unknown strand exits 1 with not_found and lists the available names', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await strands(['不存在的线']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stderr.join('\n')).toContain('面试准备');
    expect(stdout).toEqual([]);
  });

  it('prototype keys (constructor / __proto__) are not strands', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    for (const name of ['constructor', '__proto__', 'toString']) {
      const code = await strands([name]);
      expect(code).toBe(1);
      expect(stderr.join('\n')).toContain('[not_found]');
      stderr = [];
    }
    expect(stdout).toEqual([]);
  });

  it('missing strands.json exits 1 with not_found', async () => {
    saveConfig(defaultConfig(resolvePaths()), resolvePaths()); // no memory tree written

    const code = await strands([]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });
});

describe('relPathToSliceId', () => {
  it('renders stored rel-paths as slice ids', () => {
    expect(relPathToSliceId('2026/08/10/1401')).toBe('2026-08-10-1401');
    expect(relPathToSliceId('2026/08/10')).toBe('2026-08-10'); // legacy date-only
  });

  it('reports unexpected shapes verbatim instead of fabricating', () => {
    expect(relPathToSliceId('weird')).toBe('weird');
  });
});

describe('truncateStrandsOutput', () => {
  it('caps the output and states the truncation explicitly', () => {
    const out = truncateStrandsOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateStrandsOutput(content, 100)).toBe(content);
  });
});
