import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as recall, describeMatchPath, formatRecallOutput, timelineTail } from '../src/commands/recall.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import type { SearchResult } from '../src/lib/memory.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('recall command', () => {
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

  it('usage error without a query exits 2', async () => {
    const code = await recall([]);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Usage: previously recall');
    expect(stdout).toEqual([]);
  });

  it('a match prints pointers: slice id, role, path:line, excerpt', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await recall(['面试']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('[slice 2026-08-10-1401]');
    expect(out).toContain('episodic/slices/2026/08/10/1401/timeline/core.md:');
    expect(out).toContain('帮我准备周五 Apex Intelligence 的面试');
    // The monthly manifest match is reported with the index role.
    expect(out).toContain('[index]');
    // The output points at readslice instead of exposing full content.
    expect(out).toContain('previously readslice <sliceId>');
  });

  it('the timeline tail lists the latest slice pointers', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await recall(['面试']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('Timeline tail');
    expect(out).toContain('- **2026-08-10-1401** 面试准备：Apex Intelligence 自进化');
    expect(out).toContain('- **2026-07-28-0658** 第一次见面');
  });

  it('no matches is a success with a clear no-match line', async () => {
    writeFixtureMemory(home);
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());

    const code = await recall(['绝不存在的词xyz']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('No memory matches for "绝不存在的词xyz".');
  });

  it('uninitialized memory exits 1 with an honest not_found error', async () => {
    saveConfig(defaultConfig(resolvePaths()), resolvePaths()); // no memory tree written

    const code = await recall(['anything']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[not_found]');
    expect(stdout).toEqual([]);
  });
});

describe('describeMatchPath', () => {
  it('derives the slice id and role from slice paths', () => {
    expect(describeMatchPath('episodic/slices/2026/08/10/1401/timeline/core.md')).toEqual({
      sliceId: '2026-08-10-1401',
      role: 'slice',
    });
    expect(describeMatchPath('episodic/slices/2026/08/_index.json')).toEqual({
      sliceId: null,
      role: 'index',
    });
  });
});

describe('timelineTail', () => {
  it('keeps only slice-entry lines, capped at the tail length', () => {
    const timeline = [
      '# Timeline',
      '## 2026-08',
      ...Array.from({ length: 30 }, (_, i) => `- **2026-08-10-${String(1000 + i)}** entry ${i}`),
      'not an entry',
    ].join('\n');
    const tail = timelineTail(timeline, 5);
    expect(tail).toHaveLength(5);
    expect(tail[0]).toContain('entry 25');
    expect(tail[4]).toContain('entry 29');
  });
});

describe('formatRecallOutput truncation', () => {
  it('caps the output and states the truncation explicitly', () => {
    const result: SearchResult = {
      query: 'q',
      matchCount: 3,
      truncated: false,
      matches: [
        { path: 'episodic/slices/2026/08/10/1401/timeline/core.md', line: 1, text: 'x'.repeat(200) },
        { path: 'episodic/slices/2026/08/10/1401/timeline/core.md', line: 2, text: 'y'.repeat(200) },
        { path: 'episodic/slices/2026/08/10/1401/timeline/core.md', line: 3, text: 'z'.repeat(200) },
      ],
    };
    const out = formatRecallOutput(result, [], 300);
    expect(out.length).toBeLessThanOrEqual(300 + 200); // cap + the note itself
    expect(out).toContain('output truncated at 300 chars');
  });

  it('under the cap, no truncation note appears', () => {
    const result: SearchResult = { query: 'q', matchCount: 0, truncated: false, matches: [] };
    const out = formatRecallOutput(result, [], 30_000);
    expect(out).toContain('No memory matches');
    expect(out).not.toContain('output truncated');
  });
});
