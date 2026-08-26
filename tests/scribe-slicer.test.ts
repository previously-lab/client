import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleExchanges,
  renderAgentMarkdown,
  renderSliceMarkdown,
  resolveSliceId,
  sliceIdFromTimestamp,
  toIndexEntry,
  upsertMonthlyIndex,
  writeSessionSlice,
} from '../src/scribe/slicer.js';
import type { SessionState, TranscriptEvent } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    source: 'claude-code',
    sessionId: 'sess-1',
    sliceId: '2026-08-10-1401',
    events: [
      { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '帮我整理项目结构' },
      { timestamp: '2026-08-10T14:01:05.000Z', kind: 'agent-text', text: '好的，我先看一下。' },
      {
        timestamp: '2026-08-10T14:01:05.000Z',
        kind: 'tool-call',
        toolName: 'Bash',
        text: 'ls -la',
        toolCallId: 'toolu_0',
      },
      {
        timestamp: '2026-08-10T14:01:06.000Z',
        kind: 'tool-result',
        toolCallId: 'toolu_0',
        text: 'src tests',
        isError: false,
      },
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
    // One exchange = one user Turn + one agent Turn sharing the turn id;
    // tool chatter lives in agent.md, not as `**Tool:**` pseudo-turns.
    const turns = [...md.matchAll(/^## Turn (\S+) — .* \((user|agent)\)$/gm)];
    expect(turns.map((m) => m[2])).toEqual(['user', 'agent']);
    expect(turns[0]![1]).toBe(turns[1]![1]);
    expect(md).not.toContain('**Tool:**');
  });

  it('is deterministic: same events → same bytes (content-hash dedup)', () => {
    const a = renderSliceMarkdown(makeSession(), '2026-08-10-1401', 'Asia/Shanghai');
    const b = renderSliceMarkdown(makeSession(), '2026-08-10-1401', 'Asia/Shanghai');
    expect(a).toBe(b);
  });
});

describe('assembleExchanges', () => {
  it('groups events by user-message boundaries', () => {
    const exchanges = assembleExchanges(makeSession().events);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.user!.kind).toBe('user');
    expect(exchanges[0]!.agentEvents.map((e) => e.kind)).toEqual(['agent-text', 'tool-call', 'tool-result']);
  });

  it('puts agent events before the first user message into a user-less leading exchange', () => {
    const events: TranscriptEvent[] = [
      { timestamp: '2026-08-10T14:00:00.000Z', kind: 'agent-text', text: '续上次的进度…' },
      { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '继续' },
      { timestamp: '2026-08-10T14:01:05.000Z', kind: 'agent-text', text: '好。' },
    ];
    const exchanges = assembleExchanges(events);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.user).toBeNull();
    expect(exchanges[0]!.agentEvents).toHaveLength(1);
    expect(exchanges[1]!.user!.text).toBe('继续');
    // The leading exchange still renders as an agent Turn in core.md.
    const md = renderSliceMarkdown(makeSession({ events }), '2026-08-10-1401', 'Asia/Shanghai');
    expect(md).toContain('续上次的进度…');
    const turns = [...md.matchAll(/^## Turn \S+ — .* \((user|agent)\)$/gm)];
    expect(turns.map((m) => m[1])).toEqual(['agent', 'user', 'agent']);
  });
});

describe('renderAgentMarkdown', () => {
  it('renders one Cognition block per exchange, pairing tool calls with results', () => {
    const session = makeSession({
      events: [
        { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '第一问' },
        { timestamp: '2026-08-10T14:01:05.000Z', kind: 'thinking', text: '先想想第一问。' },
        {
          timestamp: '2026-08-10T14:01:06.000Z',
          kind: 'tool-call',
          toolName: 'Bash',
          text: 'ls',
          toolCallId: 'c1',
        },
        {
          timestamp: '2026-08-10T14:01:07.000Z',
          kind: 'tool-result',
          toolCallId: 'c1',
          text: 'ok output',
          isError: false,
        },
        { timestamp: '2026-08-10T14:01:09.000Z', kind: 'agent-text', text: '第一答' },
        { timestamp: '2026-08-10T14:02:00.000Z', kind: 'user', text: '第二问' },
        {
          timestamp: '2026-08-10T14:02:05.000Z',
          kind: 'tool-call',
          toolName: 'Read',
          text: 'a.ts',
          toolCallId: 'c2',
        },
        {
          timestamp: '2026-08-10T14:02:06.000Z',
          kind: 'tool-result',
          toolCallId: 'c2',
          text: 'ENOENT: no such file',
          isError: true,
        },
        { timestamp: '2026-08-10T14:02:09.000Z', kind: 'agent-text', text: '第二答' },
      ],
    });

    const core = renderSliceMarkdown(session, '2026-08-10-1401', 'Asia/Shanghai');
    const coreTurnIds = [...core.matchAll(/^## Turn (\S+) — .* \(user\)$/gm)].map((m) => m[1]);
    expect(coreTurnIds).toHaveLength(2);
    expect((core.match(/^## Turn /gm) ?? []).length).toBe(4);

    const agent = renderAgentMarkdown(session);
    expect(agent).not.toBeNull();
    const cognitions = [...agent!.matchAll(/^## Cognition (\S+) — (.+)$/gm)];
    expect(cognitions.map((m) => m[1])).toEqual(coreTurnIds);
    expect(agent).toContain('### Thinking\n\n先想想第一问。');
    expect(agent).toContain('- `Bash`(ls) → ok');
    expect(agent).toContain('- `Read`(a.ts) → error: ENOENT: no such file');
  });

  it('renders unpaired results (task notifications) as standalone tool lines', () => {
    const session = makeSession({
      events: [
        { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '干活' },
        {
          timestamp: '2026-08-10T14:05:00.000Z',
          kind: 'tool-result',
          toolName: 'task',
          text: '子代理完成了代码搜索',
          isError: false,
        },
      ],
    });
    const agent = renderAgentMarkdown(session);
    expect(agent).toContain('- `task` → ok: 子代理完成了代码搜索');
  });

  it('returns null when the session produced no cognition', () => {
    const session = makeSession({
      events: [
        { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '你好' },
        { timestamp: '2026-08-10T14:01:05.000Z', kind: 'agent-text', text: '你好！' },
      ],
    });
    expect(renderAgentMarkdown(session)).toBeNull();
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

  it('writes agent.md with the cognition record when the session has any', () => {
    setup();
    const result = writeSessionSlice(memory, makeSession(), 'Asia/Shanghai');
    const agent = readFileSync(join(result.sliceDir, 'agent.md'), 'utf8');
    expect(agent).toMatch(/^## Cognition [A-Za-z0-9_-]{6} — 2026-08-10T14:01:05\.000Z/m);
    expect(agent).toContain('### Tools');
    expect(agent).toContain('- `Bash`(ls -la) → ok');
  });

  it('omits agent.md when there is no cognition, and removes a stale one', () => {
    setup();
    const session = makeSession({
      events: [
        { timestamp: '2026-08-10T14:01:00.000Z', kind: 'user', text: '你好' },
        { timestamp: '2026-08-10T14:01:05.000Z', kind: 'agent-text', text: '你好！' },
      ],
    });
    const result = writeSessionSlice(memory, session, 'Asia/Shanghai');
    const agentPath = join(result.sliceDir, 'agent.md');
    expect(existsSync(agentPath)).toBe(false);

    // A stale agent.md from an earlier parser version must not linger.
    writeFileSync(agentPath, '## Cognition stale — old\n', 'utf8');
    writeSessionSlice(memory, session, 'Asia/Shanghai');
    expect(existsSync(agentPath)).toBe(false);
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
