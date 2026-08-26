import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as card, truncateCardOutput } from '../src/commands/card.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('card command', () => {
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
    delete process.env.PREVIOUSLY_READER_SCOPE;
    cleanupTempHome(home);
  });

  it('housekeeping scope allows the card read forms', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());
    process.env.PREVIOUSLY_READER_SCOPE = 'housekeeping';

    const code = await card([]);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('# Previously');
  });

  it('card bootstrap is refused under ANY non-empty scope (chat and housekeeping)', async () => {
    for (const scope of ['chat', 'housekeeping', 'unknown-scope']) {
      process.env.PREVIOUSLY_READER_SCOPE = scope;
      const code = await card(['bootstrap', '--empty']);
      expect(code).toBe(1);
      const err = stderr.join('\n');
      expect(err).toContain('card bootstrap');
      expect(err).toContain('PREVIOUSLY_READER_SCOPE');
      stderr = [];
    }
    expect(stdout).toEqual([]);
  });

  it('usage errors exit 2: positional arg, unknown flag, missing --slice value', async () => {
    expect(await card(['2026-08-10-1401'])).toBe(2);
    expect(await card(['--bogus'])).toBe(2);
    expect(await card(['--slice'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('without --slice, prints the live card', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await card([]);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('# Previously');
    expect(out).toContain('正在准备 Apex Intelligence 面试（周五）');
    expect(out).toContain('关注自进化话题');
    expect(out).not.toContain('snapshot');
  });

  it('--slice prints that slice’s card snapshot', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await card(['--slice', '2026-08-10-1401']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('# Previously (snapshot @ 2026-08-10-1401)');
    expect(out).toContain('正在准备 Apex Intelligence 面试');
  });

  it('--slice on a slice without a snapshot exits 1 with not_found', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await card(['--slice', '2026-08-09-1546']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });

  it('a malformed --slice id exits 1 with invalid_id (path traversal refused)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await card(['--slice', '../../etc/passwd']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_id]');
    expect(stdout).toEqual([]);
  });

  it('a missing live card exits 1 with not_found', async () => {
    saveConfig(defaultConfig(resolvePaths()), resolvePaths()); // no memory tree written

    const code = await card([]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });
});

describe('truncateCardOutput', () => {
  it('caps the content and states the truncation explicitly', () => {
    const out = truncateCardOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateCardOutput(content, 100)).toBe(content);
  });
});
