import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as agentlog, truncateAgentlogOutput } from '../src/commands/agentlog.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('agentlog command', () => {
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

  it('housekeeping scope allows agentlog (card-evolution forensics)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());
    process.env.PREVIOUSLY_READER_SCOPE = 'housekeeping';

    const code = await agentlog(['2026-08-10-1401']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Agent Timeline');
  });

  it('usage errors exit 2: missing id, extra positional, unknown flag, bad range value', async () => {
    expect(await agentlog([])).toBe(2);
    expect(await agentlog(['a', 'b'])).toBe(2);
    expect(await agentlog(['2026-08-10-1401', '--bogus'])).toBe(2);
    expect(await agentlog(['2026-08-10-1401', '--start', 'abc'])).toBe(2);
    expect(await agentlog(['2026-08-10-1401', '--start', '0'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('prints the slice cognition record', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await agentlog(['2026-08-10-1401']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('# Agent Timeline — 2026-08-10-1401');
    expect(out).toContain('- classified intent: chat');
    expect(out).toContain('- proposed strand: 面试准备');
  });

  it('--start/--end narrow the output to the 1-based inclusive line range', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await agentlog(['2026-08-10-1401', '--start', '3', '--end', '5']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe(
      ['## Turn a1b2c3 (user)', '- classified intent: chat', '- recalled: 面试准备'].join('\n'),
    );
  });

  it('a slice without an agent timeline exits 1 with not_found', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await agentlog(['2026-08-09-1546']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });

  it('a malformed slice id exits 1 with invalid_id (path traversal refused)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await agentlog(['../../etc/passwd']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_id]');
    expect(stdout).toEqual([]);
  });

  it('an inverted range exits 1 with invalid_args', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await agentlog(['2026-08-10-1401', '--start', '5', '--end', '3']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_args]');
    expect(stdout).toEqual([]);
  });
});

describe('truncateAgentlogOutput', () => {
  it('caps the content and states the truncation explicitly', () => {
    const out = truncateAgentlogOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
    expect(out).toContain('--start/--end');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateAgentlogOutput(content, 100)).toBe(content);
  });
});
