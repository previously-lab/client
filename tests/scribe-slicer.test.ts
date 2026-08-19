import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderSliceMarkdown,
  resolveSliceId,
  sliceIdFromTimestamp,
  toIndexEntry,
  upsertMonthlyIndex,
  writeSessionSlice,
} from '../src/scribe/slicer.js';
import type { SessionState } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    source: 'claude-code',
    sessionId: 'sess-1',
    sliceId: '2026-08-10-1401',
    events: [
      { timestamp: '2026-08-10T14:01:00.000Z', role: 'user', text: '帮我整理项目结构' },
      { timestamp: '2026-08-10T14:01:05.000Z', role: 'agent', text: '好的，我先看一下。' },
      { timestamp: '2026-08-10T14:01:05.000Z', role: 'agent', toolName: 'Bash', text: 'ls -la' },
    ],
    appendix: [],
    parseErrors: 0,
    ...overrides,
  };
}

describe('sliceIdFromTimestamp', () => {
  it('derives YYYY-MM-DD-HHMM in UTC', () => {
    expect(sliceIdFromTimestamp('2026-08-10T14:01:00.000Z')).toBe('2026-08-10-1401');
    expect(sliceIdFromTimestamp('2026-08-10T14:01:59.999Z')).toBe('2026-08-10-1401');
  });

  it('rejects unparseable timestamps', () => {
    expect(() => sliceIdFromTimestamp('not-a-date')).toThrow();
  });
});

describe('renderSliceMarkdown', () => {
  it('mirrors the kernel slice layout: frontmatter + turn headings', () => {
    const md = renderSliceMarkdown(makeSession(), '2026-08-10-1401', 'Asia/Shanghai');
    const lines = md.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines).toContain('slice_id: 2026-08-10-1401');
    expect(lines).toContain('status: active');
    expect(lines).toContain("start: '2026-08-10T14:01:00.000Z'");
    expect(lines).toContain('timezone: Asia/Shanghai');
    expect(lines).toContain('source: claude-code');
    expect(lines).toContain('session_id: sess-1');
    expect(lines).toContain('open_loops: []');
    expect(lines).toContain('loops: []');
    expect(md).toMatch(/## Turn [A-Za-z0-9_-]{6} — 2026-08-10T14:01:00\.000Z \(user\)\n\n帮我整理项目结构/);
    expect(md).toContain('**Tool: Bash**\n\nls -la');
  });

  it('is deterministic: same events → same bytes (content-hash dedup)', () => {
    const a = renderSliceMarkdown(makeSession(), '2026-08-10-1401', 'Asia/Shanghai');
    const b = renderSliceMarkdown(makeSession(), '2026-08-10-1401', 'Asia/Shanghai');
    expect(a).toBe(b);
  });
});

describe('writeSessionSlice', () => {
  let home: string;
  let memory: string;
  afterEach(() => cleanupTempHome(home));

  function setup(): void {
    home = useTempHome();
    memory = join(home, 'memory');
  }

  it('writes the agent-repo layout: episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md', () => {
    setup();
    const result = writeSessionSlice(memory, makeSession(), 'Asia/Shanghai');
    expect(result.sliceDir).toBe(
      join(memory, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline'),
    );
    expect(existsSync(join(result.sliceDir, 'core.md'))).toBe(true);
    expect(result.coreChanged).toBe(true);
  });

  it('re-writing identical events is byte-identical and skipped', () => {
    setup();
    writeSessionSlice(memory, makeSession(), 'Asia/Shanghai');
    const core = join(memory, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md');
    const before = readFileSync(core, 'utf8');
    const second = writeSessionSlice(memory, makeSession(), 'Asia/Shanghai');
    expect(second.coreChanged).toBe(false);
    expect(readFileSync(core, 'utf8')).toBe(before);
  });

  it('writes appendix.md with raw unparseable lines', () => {
    setup();
    const session = makeSession({ appendix: ['{"broken": true'], parseErrors: 1 });
    const result = writeSessionSlice(memory, session, 'Asia/Shanghai');
    const appendix = readFileSync(join(result.sliceDir, 'appendix.md'), 'utf8');
    expect(appendix).toContain('{"broken": true');
    expect(appendix).toContain('slice_id: 2026-08-10-1401');
  });

  it('refuses to render a session with no events', () => {
    setup();
    expect(() => writeSessionSlice(memory, makeSession({ events: [] }), 'Asia/Shanghai')).toThrow();
  });
});

describe('monthly _index.json', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('writes the agent-repo manifest shape plus source/sessionId labels', () => {
    home = useTempHome();
    const memory = join(home, 'memory');
    const session = makeSession();
    upsertMonthlyIndex(memory, toIndexEntry(session, '2026-08-10-1401'));

    const indexPath = join(memory, 'episodic', 'slices', '2026', '08', '_index.json');
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      month: string;
      slices: Record<string, unknown>[];
    };
    expect(parsed.month).toBe('2026-08');
    expect(parsed.slices).toEqual([
      {
        id: '2026-08-10-1401',
        focus: '',
        summary: '',
        tags: [],
        status: 'active',
        start: '2026-08-10T14:01:00.000Z',
        open_loops: [],
        decisions: [],
        source: 'claude-code',
        sessionId: 'sess-1',
      },
    ]);
  });

  it('upserts by id and keeps entries sorted ascending', () => {
    home = useTempHome();
    const memory = join(home, 'memory');
    const later = makeSession({ sessionId: 'sess-2' });
    const earlier = makeSession({ sessionId: 'sess-1' });
    upsertMonthlyIndex(memory, toIndexEntry(later, '2026-08-10-1530'));
    upsertMonthlyIndex(memory, toIndexEntry(earlier, '2026-08-10-1401'));
    // Same id again → replace, not duplicate.
    upsertMonthlyIndex(memory, toIndexEntry(later, '2026-08-10-1530'));

    const indexPath = join(memory, 'episodic', 'slices', '2026', '08', '_index.json');
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { slices: { id: string }[] };
    expect(parsed.slices.map((s) => s.id)).toEqual(['2026-08-10-1401', '2026-08-10-1530']);
  });
});

describe('resolveSliceId', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('uses the first event timestamp; same-minute foreign sessions bump by a minute', () => {
    home = useTempHome();
    const memory = join(home, 'memory');
    const ts = '2026-08-10T14:01:00.000Z';

    const first = resolveSliceId(memory, 'sess-a', ts);
    expect(first).toBe('2026-08-10-1401');
    writeSessionSlice(memory, makeSession({ sessionId: 'sess-a', sliceId: first }), 'Asia/Shanghai');

    // A different session starting in the same minute must not overwrite it.
    const second = resolveSliceId(memory, 'sess-b', ts);
    expect(second).toBe('2026-08-10-1402');

    // The owning session keeps its slot on resume.
    expect(resolveSliceId(memory, 'sess-a', ts)).toBe('2026-08-10-1401');
  });
});
