import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as ingest } from '../src/commands/ingest.js';
import { admitSlice, parseSubmittedSlice, type SubmittedSlice } from '../src/lib/ingest.js';
import {
  compressSliceForMarking,
  findDrySlices,
  parseMarkingResponse,
  patchSliceFrontmatter,
} from '../src/lib/marking.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, replyFixtureScript } from './bridge-fixtures.js';

/**
 * Semantic-marking tests. Library functions are pure/in-memory except
 * applyMark (covered end-to-end via the command). Command runs are sandboxed
 * by PREVIOUSLY_HOME and a fixture brain CLI (PREVIOUSLY_BRIDGE_CLAUDE_CMD).
 */

let home: string;
let memoryRoot: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = useTempHome();
  memoryRoot = join(home, 'memory');
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD;
  delete process.env.FIXTURE_MARKER;
  cleanupTempHome(home);
});

/** Submit + admit one slice; focus/summary/tags optional (absent = dry). */
function submitSlice(
  sliceId: string,
  sessionId: string,
  extra: { focus?: string; summary?: string; tags?: string[] } = {},
): SubmittedSlice {
  const [y, m, d, hm] = sliceId.split('-');
  const start = `${y}-${m}-${d}T${hm!.slice(0, 2)}:${hm!.slice(2, 4)}:00.000Z`;
  const lines = [
    '---',
    `slice_id: ${sliceId}`,
    'status: closed',
    `start: '${start}'`,
    `end: '${start}'`,
    'source: test',
    `session_id: ${sessionId}`,
  ];
  if (extra.focus !== undefined) lines.push(`focus: ${extra.focus}`);
  if (extra.summary !== undefined) lines.push(`summary: ${extra.summary}`);
  lines.push(`tags: [${(extra.tags ?? []).join(', ')}]`, '---', `## Turn t1 — ${start} (user)`, '', '你好', '');
  const { slice, issues } = parseSubmittedSlice(lines.join('\n'));
  if (slice === null) throw new Error(`fixture doc rejected: ${JSON.stringify(issues)}`);
  admitSlice(memoryRoot, slice, 'UTC');
  return slice;
}

function corePath(sliceId: string): string {
  const [y, m, d, hm] = sliceId.split('-');
  return join(memoryRoot, 'episodic', 'slices', y!, m!, d!, hm!, 'timeline', 'core.md');
}

describe('findDrySlices', () => {
  it('picks only entries with BOTH focus and summary empty', () => {
    submitSlice('2026-01-15-1430', 'sess-dry');
    submitSlice('2026-01-15-1500', 'sess-marked', { focus: '面试准备', summary: '准备了面试' });
    submitSlice('2026-01-15-1600', 'sess-focus-only', { focus: '只有 focus' });

    const dry = findDrySlices(memoryRoot);
    expect(dry.map((d) => d.sliceId)).toEqual(['2026-01-15-1430']);
    expect(dry[0]!.sessionId).toBe('sess-dry');
  });

  it('an empty memory root yields no dry slices', () => {
    expect(findDrySlices(memoryRoot)).toEqual([]);
  });
});

describe('compressSliceForMarking', () => {
  function coreWithTurns(n: number, bodyLen = 10): string {
    const parts = ['---\nslice_id: 2026-01-15-1430\nstatus: closed\n---'];
    for (let i = 0; i < n; i++) {
      const role = i % 2 === 0 ? 'user' : 'agent';
      const ts = new Date(Date.parse('2026-01-15T14:30:00.000Z') + i * 60_000).toISOString();
      parts.push(`## Turn t${i} — ${ts} (${role})\n\nbody-${i}-` + 'x'.repeat(bodyLen));
    }
    return parts.join('\n\n');
  }

  it('keeps the first turn plus the last 10, stating the omitted middle', () => {
    const text = compressSliceForMarking(coreWithTurns(15));
    expect(text).toContain('(4 middle turns omitted)');
    expect(text).toContain('body-0-');
    expect(text).toContain('body-5-');
    expect(text).toContain('body-14-');
    expect(text).not.toContain('body-1-');
    expect(text).not.toContain('body-4-');
  });

  it('truncates each turn body at 300 chars', () => {
    const text = compressSliceForMarking(coreWithTurns(2, 500));
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('…');
  });

  it('a core without parseable turns says so honestly', () => {
    expect(compressSliceForMarking('---\nslice_id: x\n---\nno turns here')).toBe('(no parseable turns)');
  });
});

describe('parseMarkingResponse', () => {
  it('parses a clean JSON reply', () => {
    const mark = parseMarkingResponse('{"focus":"项目整理","summary":"讨论了目录结构","tags":["项目开发","ingest"]}');
    expect(mark).toEqual({ focus: '项目整理', summary: '讨论了目录结构', tags: ['项目开发', 'ingest'] });
  });

  it('tolerates markdown fences around the JSON', () => {
    const mark = parseMarkingResponse('```json\n{"focus":"f","summary":"s","tags":[]}\n```');
    expect(mark).toEqual({ focus: 'f', summary: 's', tags: [] });
  });

  it('truncates an over-100-char summary with an ellipsis', () => {
    const mark = parseMarkingResponse(JSON.stringify({ focus: 'f', summary: 's'.repeat(150), tags: [] }));
    expect(mark.summary.length).toBe(100);
    expect(mark.summary.endsWith('…')).toBe(true);
  });

  it('throws on a non-JSON reply', () => {
    expect(() => parseMarkingResponse('sorry, I cannot help')).toThrowError(/no JSON object/);
  });

  it('throws when both focus and summary are empty', () => {
    expect(() => parseMarkingResponse('{"focus":"","summary":"","tags":["t"]}')).toThrowError(/neither focus nor summary/);
  });
});

describe('patchSliceFrontmatter', () => {
  const BASE_CORE = [
    '---',
    'slice_id: 2026-01-15-1430',
    'status: closed',
    "start: '2026-01-15T14:30:00.000Z'",
    "end: '2026-01-15T14:30:00.000Z'",
    'source: test',
    'session_id: sess-1',
    'tags: []',
    '---',
    '## Turn t1 — 2026-01-15T14:30:00.000Z (user)',
    '',
    '你好',
    '',
  ].join('\n');

  it('replaces existing single-line values', () => {
    const core = BASE_CORE.replace('tags: []', 'summary: old summary\ntags: []');
    const { patched, skippedKeys } = patchSliceFrontmatter(core, { focus: '', summary: 'new summary', tags: [] });
    expect(skippedKeys).toEqual([]);
    expect(patched).toContain('new summary');
    expect(patched).not.toContain('old summary');
  });

  it('inserts missing keys before the closing frontmatter delimiter', () => {
    const { patched } = patchSliceFrontmatter(BASE_CORE, { focus: '面试准备', summary: '准备了面试', tags: ['面试'] });
    const lines = patched.split('\n');
    const closing = lines.lastIndexOf('---');
    const focusIdx = lines.findIndex((l) => l.startsWith('focus:'));
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary:'));
    expect(focusIdx).toBeGreaterThan(0);
    expect(focusIdx).toBeLessThan(closing);
    expect(summaryIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeLessThan(closing);
    expect(patched).toContain('面试准备');
    expect(patched).toMatch(/^tags: \[.*面试.*\]$/m); // yamlScalar quotes non-ASCII values
  });

  it('preserves the turn body byte-for-byte', () => {
    const { patched } = patchSliceFrontmatter(BASE_CORE, { focus: '面试准备', summary: '准备了面试', tags: ['面试'] });
    expect(patched).toContain('## Turn t1 — 2026-01-15T14:30:00.000Z (user)');
    expect(patched.trimEnd().endsWith('你好')).toBe(true);
  });

  it('skips block-scalar keys and reports them in skippedKeys', () => {
    const core = BASE_CORE.replace('tags: []', 'summary: >-\n  folded summary line\ntags: []');
    const { patched, skippedKeys } = patchSliceFrontmatter(core, { focus: 'f', summary: 'new', tags: [] });
    expect(skippedKeys).toEqual(['summary']);
    expect(patched).toContain('summary: >-');
    expect(patched).toContain('folded summary line');
    expect(patched).not.toContain('summary: new');
  });

  it('empty mark tags never clear an existing non-empty tags list', () => {
    const core = BASE_CORE.replace('tags: []', 'tags: [keepme]');
    const { patched } = patchSliceFrontmatter(core, { focus: 'f', summary: '', tags: [] });
    expect(patched).toContain('tags: [keepme]');
    expect(patched).toContain('focus: f');
  });
});

describe('previously ingest --mark --yes (fixture brain)', () => {
  it('fills focus/summary/tags on dry slices in core.md and _index.json', async () => {
    submitSlice('2026-01-15-1430', 'sess-dry');
    const fixtureDir = join(home, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, 'reply.js');
    writeFileSync(
      fixture,
      replyFixtureScript('{"focus":"ingest 契约","summary":"核对了提交契约并写入切片","tags":["ingest","测试"]}'),
      'utf8',
    );
    const marker = join(home, 'dispatched.marker');
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixture);
    process.env.FIXTURE_MARKER = marker;

    const code = await ingest(['--mark', '--agent', 'claude', '--yes']);
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(stdout.join('\n')).toContain('1 dry slice(s)');
    expect(stdout.join('\n')).toContain('Marking done: 1 marked, 0 failed.');

    const core = readFileSync(corePath('2026-01-15-1430'), 'utf8');
    expect(core).toContain('ingest 契约');
    expect(core).toContain('核对了提交契约并写入切片');
    expect(core).toContain('ingest');
    const index = JSON.parse(
      readFileSync(join(memoryRoot, 'episodic', 'slices', '2026', '01', '_index.json'), 'utf8'),
    ) as { slices: { id: string; focus: string; summary: string; tags: string[] }[] };
    expect(index.slices[0]!.focus).toBe('ingest 契约');
    expect(index.slices[0]!.summary).toBe('核对了提交契约并写入切片');
    expect(index.slices[0]!.tags).toEqual(['ingest', '测试']);

    // The slice is no longer dry.
    expect(findDrySlices(memoryRoot)).toEqual([]);
  });

  it('with no dry slices there is nothing to do (exit 0, no dispatch)', async () => {
    submitSlice('2026-01-15-1430', 'sess-marked', { focus: '已有标记', summary: '已有摘要' });
    const marker = join(home, 'dispatched.marker');
    process.env.FIXTURE_MARKER = marker;
    const code = await ingest(['--mark', '--agent', 'claude', '--yes']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('No dry slices');
    expect(existsSync(marker)).toBe(false);
  });
});
