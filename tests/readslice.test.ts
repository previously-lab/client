import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as readslice, truncateSliceOutput } from '../src/commands/readslice.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('readslice command', () => {
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

  it('usage errors exit 2: missing id, extra positional, unknown flag, bad range value', async () => {
    expect(await readslice([])).toBe(2);
    expect(await readslice(['a', 'b'])).toBe(2);
    expect(await readslice(['2026-08-10-1401', '--bogus'])).toBe(2);
    expect(await readslice(['2026-08-10-1401', '--start', 'abc'])).toBe(2);
    expect(await readslice(['2026-08-10-1401', '--start', '0'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('prints the slice conversation record', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await readslice(['2026-08-10-1401']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('slice_id: 2026-08-10-1401');
    expect(out).toContain('帮我准备周五 Apex Intelligence 的面试');
    expect(out).toContain('好的，我们先从自进化这个主题开始。');
  });

  it('--start/--end narrow the output to the 1-based inclusive line range', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await readslice(['2026-08-10-1401', '--start', '6', '--end', '8']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toBe(
      ['## Turn a1b2c3 — 2026-08-10T14:01:00.000Z (user)', '', '帮我准备周五 Apex Intelligence 的面试'].join('\n'),
    );
  });

  it('an unknown slice id exits 1 with not_found', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await readslice(['2026-08-11-0900']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });

  it('a malformed slice id exits 1 with invalid_id (path traversal refused)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await readslice(['../../etc/passwd']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_id]');
    expect(stdout).toEqual([]);
  });
});

describe('truncateSliceOutput', () => {
  it('caps the content and states the truncation explicitly', () => {
    const out = truncateSliceOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
    expect(out).toContain('--start/--end');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateSliceOutput(content, 100)).toBe(content);
  });
});
