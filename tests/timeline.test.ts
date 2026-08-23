import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as timeline, truncateTimelineOutput } from '../src/commands/timeline.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('timeline command', () => {
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

  it('usage errors exit 2: positional arg, unknown flag, missing flag value', async () => {
    expect(await timeline(['2026-08'])).toBe(2);
    expect(await timeline(['--bogus'])).toBe(2);
    expect(await timeline(['--month'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('out-of-range month/day values exit 1 with invalid_args (not a silent miss)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    expect(await timeline(['--month', '2026-13'])).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_args]');
    stderr = [];
    expect(await timeline(['--month', '2026-08', '--day', '13-45'])).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_args]');
    expect(stdout).toEqual([]);
  });

  it('prints the full human timeline without filters', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await timeline([]);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('# Timeline');
    expect(out).toContain('## 2026-08');
    expect(out).toContain('- **2026-08-10-1401** 面试准备：Apex Intelligence 自进化');
    expect(out).toContain('## 2026-07');
  });

  it('--month narrows to one month section', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await timeline(['--month', '2026-08']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('## 2026-08');
    expect(out).not.toContain('## 2026-07');
    expect(out).not.toContain('第一次见面');
  });

  it('--month + --day narrow to one day section', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await timeline(['--month', '2026-08', '--day', '08-09']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('### 08-09');
    expect(out).toContain('版本更新讨论');
    expect(out).not.toContain('面试准备');
  });

  it('a malformed filter exits 1 with invalid_args', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await timeline(['--month', '2026/08']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_args]');
    expect(stdout).toEqual([]);
  });

  it('a filter matching nothing exits 1 with not_found', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await timeline(['--month', '2025-01']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });

  it('uninitialized memory exits 1 with an honest not_found error', async () => {
    saveConfig(defaultConfig(resolvePaths()), resolvePaths()); // no memory tree written

    const code = await timeline([]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });
});

describe('truncateTimelineOutput', () => {
  it('caps the content and states the truncation explicitly', () => {
    const out = truncateTimelineOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
    expect(out).toContain('--month/--day');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateTimelineOutput(content, 100)).toBe(content);
  });
});
