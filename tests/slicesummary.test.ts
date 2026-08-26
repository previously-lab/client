import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as slicesummary, truncateSummaryOutput } from '../src/commands/slicesummary.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('slicesummary command', () => {
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

  it('housekeeping scope refuses slicesummary (exit 1, honest stderr, no stdout)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());
    process.env.PREVIOUSLY_READER_SCOPE = 'housekeeping';

    const code = await slicesummary(['2026-08-10-1401']);
    expect(code).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('slicesummary');
    expect(err).toContain('housekeeping');
    expect(stdout).toEqual([]);
  });

  it('usage errors exit 2: missing id, extra positional', async () => {
    expect(await slicesummary([])).toBe(2);
    expect(await slicesummary(['a', 'b'])).toBe(2);
    expect(stdout).toEqual([]);
  });

  it('prints ONLY the slice frontmatter, never the body', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await slicesummary(['2026-08-10-1401']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe(
      ['---', 'slice_id: 2026-08-10-1401', 'status: closed', 'tags: [面试, 自我进化]', '---'].join('\n'),
    );
  });

  it('an unknown slice id exits 1 with not_found', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await slicesummary(['2026-08-11-0900']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });

  it('a malformed slice id exits 1 with invalid_id (path traversal refused)', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await slicesummary(['../../etc/passwd']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[invalid_id]');
    expect(stdout).toEqual([]);
  });

  it('tolerates a UTF-8 BOM at the start of core.md', async () => {
    const memoryRoot = writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const corePath = join(
      memoryRoot, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md',
    );
    writeFileSync(corePath, '\uFEFF' + readFileSync(corePath, 'utf8'), 'utf8');

    const code = await slicesummary(['2026-08-10-1401']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('slice_id: 2026-08-10-1401');
  });
});

describe('truncateSummaryOutput', () => {
  it('caps the summary and states the truncation explicitly', () => {
    const out = truncateSummaryOutput('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('output truncated at 100 chars');
    expect(out).toContain('previously readslice <sliceId>');
  });

  it('under the cap, the content passes through untouched', () => {
    const content = 'short content\n';
    expect(truncateSummaryOutput(content, 100)).toBe(content);
  });
});
