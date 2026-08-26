import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as ingest } from '../src/commands/ingest.js';
import {
  admitSlice,
  findIngestedSlice,
  IngestError,
  parseSubmittedSlice,
  renderSubmittedSlice,
  type SubmittedSlice,
} from '../src/lib/ingest.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, replyFixtureScript } from './bridge-fixtures.js';
import {
  claudeAssistantLine,
  claudeMetaLines,
  claudeUserLine,
  makeFakeAgentHome,
  writeClaudeSession,
} from './scribe-fixtures.js';

/**
 * Ingest tests run fully sandboxed: PREVIOUSLY_HOME points at a temp dir (so
 * the default memory root is <home>/memory), and any model dispatch goes to a
 * fixture CLI via PREVIOUSLY_BRIDGE_<AGENT>_CMD — never the real thing.
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

/** A fully valid submission document (slice 2026-01-15-1430, session sess-1). */
const VALID_DOC = [
  '---',
  'slice_id: 2026-01-15-1430',
  'status: closed',
  "start: '2026-01-15T14:30:12.000Z'",
  "end: '2026-01-15T15:05:40.000Z'",
  'source: claude-code',
  'session_id: sess-1',
  'tags: [project, 测试]',
  '---',
  '## Turn a1B2c3 — 2026-01-15T14:30:12.000Z (user)',
  '',
  '帮我看看 ingest 的提交契约',
  '',
  '## Turn x9Y8z7 — 2026-01-15T14:31:03.000Z (agent)',
  '',
  '好的，逐条核对。',
  '',
].join('\n');

/** Parse a doc expected to be valid; fail loudly otherwise. */
function mustParse(doc: string): SubmittedSlice {
  const { slice, issues } = parseSubmittedSlice(doc);
  if (slice === null) throw new Error(`fixture doc rejected: ${JSON.stringify(issues)}`);
  return slice;
}

function corePath(sliceId: string): string {
  const [y, m, d, hm] = sliceId.split('-');
  return join(memoryRoot, 'episodic', 'slices', y!, m!, d!, hm!, 'timeline', 'core.md');
}

describe('parseSubmittedSlice', () => {
  it('parses a fully-valid document (frontmatter + turn blocks)', () => {
    const { slice, issues } = parseSubmittedSlice(VALID_DOC);
    expect(issues).toEqual([]);
    expect(slice).not.toBeNull();
    expect(slice!.sliceId).toBe('2026-01-15-1430');
    expect(slice!.start).toBe('2026-01-15T14:30:12.000Z');
    expect(slice!.end).toBe('2026-01-15T15:05:40.000Z');
    expect(slice!.source).toBe('claude-code');
    expect(slice!.sessionId).toBe('sess-1');
    expect(slice!.tags).toEqual(['project', '测试']);
    expect(slice!.turns.map((t) => [t.id, t.role])).toEqual([
      ['a1B2c3', 'user'],
      ['x9Y8z7', 'agent'],
    ]);
    expect(slice!.turns[0]!.body).toBe('帮我看看 ingest 的提交契约');
  });

  it('rejects a document without a frontmatter block', () => {
    const { slice, issues } = parseSubmittedSlice('# no frontmatter\n\n## Turn t1 — 2026-01-15T14:30:12.000Z (user)\n\nhi\n');
    expect(slice).toBeNull();
    expect(issues[0]!.path).toBe('frontmatter');
  });

  it('rejects a status other than closed', () => {
    const { slice, issues } = parseSubmittedSlice(VALID_DOC.replace('status: closed', 'status: active'));
    expect(slice).toBeNull();
    expect(issues.map((i) => i.path)).toContain('frontmatter.status');
  });

  it('rejects a slice_id that does not match the start minute', () => {
    const { slice, issues } = parseSubmittedSlice(VALID_DOC.replace('slice_id: 2026-01-15-1430', 'slice_id: 2026-01-15-1431'));
    expect(slice).toBeNull();
    expect(issues.some((i) => i.path === 'frontmatter.slice_id' && i.message.includes('does not match'))).toBe(true);
  });

  it('rejects end < start', () => {
    const { slice, issues } = parseSubmittedSlice(
      VALID_DOC.replace("end: '2026-01-15T15:05:40.000Z'", "end: '2026-01-15T14:00:00.000Z'"),
    );
    expect(slice).toBeNull();
    expect(issues.map((i) => i.path)).toContain('frontmatter.end');
  });

  it('rejects missing source / session_id provenance', () => {
    const doc = VALID_DOC.replace('source: claude-code\n', '').replace('session_id: sess-1\n', '');
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.map((i) => i.path)).toContain('frontmatter.source');
    expect(issues.map((i) => i.path)).toContain('frontmatter.session_id');
  });

  it('rejects a document with no turn blocks', () => {
    const doc = VALID_DOC.split('## Turn')[0]!;
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.some((i) => i.path === 'body' && i.message.includes('No turn blocks'))).toBe(true);
  });

  it('rejects out-of-order turn timestamps', () => {
    const doc = VALID_DOC.replace('2026-01-15T14:31:03.000Z (agent)', '2026-01-15T14:29:00.000Z (agent)');
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.map((i) => i.path)).toContain('turns[1].timestamp');
  });

  it('rejects a turn id with illegal characters', () => {
    const doc = VALID_DOC.replace('## Turn a1B2c3 —', '## Turn bad$id —');
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.map((i) => i.path)).toContain('turns[0].id');
  });

  it('rejects a turn with an empty body', () => {
    const doc = VALID_DOC.replace('\n好的，逐条核对。\n', '\n');
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.some((i) => i.path === 'turns[1].body')).toBe(true);
  });

  it('rejects stray content before the first turn header', () => {
    const doc = VALID_DOC.replace('---\n## Turn a1B2c3', '---\nsome stray preamble\n## Turn a1B2c3');
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.some((i) => i.path === 'body' && i.message.includes('Content before the first'))).toBe(true);
  });

  it('rejects block scalars in frontmatter (focus: >- with continuation lines)', () => {
    const doc = VALID_DOC.replace(
      'tags: [project, 测试]',
      'tags: [project, 测试]\nfocus: >-\n  a folded focus line',
    );
    const { slice, issues } = parseSubmittedSlice(doc);
    expect(slice).toBeNull();
    expect(issues.some((i) => i.path === 'frontmatter' && i.message.includes('block scalars'))).toBe(true);
  });
});

describe('renderSubmittedSlice', () => {
  it('renders the canonical kernel byte shape and round-trips stably', () => {
    const slice = mustParse(VALID_DOC);
    const rendered = renderSubmittedSlice(slice, 'UTC');
    expect(rendered).toContain('slice_id: 2026-01-15-1430');
    expect(rendered).toContain('status: closed');
    expect(rendered).toContain('session_id: sess-1');
    expect(rendered).toContain('closed_by: user_explicit');
    // Canonical re-render is a fixed point: parse(render(x)) renders identically.
    expect(renderSubmittedSlice(mustParse(rendered), 'UTC')).toBe(rendered);
  });
});

describe('admitSlice / findIngestedSlice', () => {
  it('writes core.md and the monthly _index.json entry', () => {
    const result = admitSlice(memoryRoot, mustParse(VALID_DOC), 'UTC');
    expect(result.action).toBe('written');
    expect(result.sliceId).toBe('2026-01-15-1430');
    expect(result.remappedFrom).toBeNull();

    const core = readFileSync(corePath('2026-01-15-1430'), 'utf8');
    expect(core).toContain('session_id: sess-1');
    expect(core).toContain('帮我看看 ingest 的提交契约');

    const index = JSON.parse(
      readFileSync(join(memoryRoot, 'episodic', 'slices', '2026', '01', '_index.json'), 'utf8'),
    ) as { slices: { id: string; source: string; sessionId: string }[] };
    expect(index.slices.map((s) => [s.id, s.source, s.sessionId])).toEqual([
      ['2026-01-15-1430', 'claude-code', 'sess-1'],
    ]);

    expect(findIngestedSlice(memoryRoot, 'claude-code', 'sess-1')?.id).toBe('2026-01-15-1430');
    expect(findIngestedSlice(memoryRoot, 'claude-code', 'nobody')).toBeNull();
  });

  it('identical re-submission under the same (source, session_id) is a no-op duplicate', () => {
    const slice = mustParse(VALID_DOC);
    admitSlice(memoryRoot, slice, 'UTC');
    const before = readFileSync(corePath('2026-01-15-1430'), 'utf8');
    const indexBefore = readFileSync(join(memoryRoot, 'episodic', 'slices', '2026', '01', '_index.json'), 'utf8');

    const again = admitSlice(memoryRoot, mustParse(VALID_DOC), 'UTC');
    expect(again.action).toBe('duplicate');
    expect(again.sliceId).toBe('2026-01-15-1430');
    expect(readFileSync(corePath('2026-01-15-1430'), 'utf8')).toBe(before);
    expect(readFileSync(join(memoryRoot, 'episodic', 'slices', '2026', '01', '_index.json'), 'utf8')).toBe(indexBefore);
  });

  it('different content under an ingested (source, session_id) is a hard IngestError', () => {
    admitSlice(memoryRoot, mustParse(VALID_DOC), 'UTC');
    const diverging = mustParse(VALID_DOC.replace('好的，逐条核对。', '改写过的回复内容。'));
    try {
      admitSlice(memoryRoot, diverging, 'UTC');
      expect.unreachable('admitSlice should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).issues[0]!.path).toBe('frontmatter.session_id');
    }
    // Never an overwrite: the original bytes survive.
    expect(readFileSync(corePath('2026-01-15-1430'), 'utf8')).toContain('好的，逐条核对。');
  });

  it('a slice_id minute taken by another session steps forward (remappedFrom set)', () => {
    admitSlice(memoryRoot, mustParse(VALID_DOC), 'UTC');
    const other = mustParse(
      VALID_DOC.replace('session_id: sess-1', 'session_id: sess-2').replace('逐条核对', '另一个会话'),
    );
    const result = admitSlice(memoryRoot, other, 'UTC');
    expect(result.action).toBe('written');
    expect(result.remappedFrom).toBe('2026-01-15-1430');
    expect(result.sliceId).toBe('2026-01-15-1431');
    expect(existsSync(corePath('2026-01-15-1430'))).toBe(true);
    expect(readFileSync(corePath('2026-01-15-1431'), 'utf8')).toContain('session_id: sess-2');
  });
});

describe('previously ingest --submit', () => {
  it('accepts a valid doc file: writes the slice itself and exits 0', async () => {
    const file = join(home, 'submission.md');
    writeFileSync(file, VALID_DOC, 'utf8');
    const code = await ingest(['--submit', file]);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('Ingested as slice 2026-01-15-1430');
    expect(out).toContain('dry'); // no focus/summary → the dry-slice note
    expect(existsSync(corePath('2026-01-15-1430'))).toBe(true);
  });

  it('rejects an invalid doc: exit 1, complete issue list, nothing written', async () => {
    const file = join(home, 'bad.md');
    writeFileSync(file, VALID_DOC.replace('status: closed', 'status: open'), 'utf8');
    const code = await ingest(['--submit', file]);
    expect(code).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('Submission rejected');
    expect(err).toContain('frontmatter.status');
    expect(existsSync(join(memoryRoot, 'episodic'))).toBe(false);
  });

  it('a missing submit file is a usage error (exit 2)', async () => {
    const code = await ingest(['--submit', join(home, 'nope.md')]);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Could not read');
  });
  // Note: '--submit -' reads process.stdin and the command exposes no stdin
  // injection seam, so the file path covers the same validate+admit flow.
});

describe('previously ingest --source', () => {
  it('transcribes a claude-code fixture log from a custom --root', async () => {
    const roots = makeFakeAgentHome(join(home, 'fakehome'));
    writeClaudeSession(roots, 'sess-a', [
      ...claudeMetaLines('sess-a'),
      claudeUserLine('帮我整理项目结构', '2026-08-10T14:01:00.000Z', 'sess-a'),
      claudeAssistantLine([{ kind: 'text', text: '好的，我先看一下。' }], '2026-08-10T14:01:05.000Z', 'sess-a'),
    ]);

    const code = await ingest(['--source', 'claude-code', '--root', roots['claude-code']]);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('1/1 files ingested');
    const core = readFileSync(
      join(memoryRoot, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md'),
      'utf8',
    );
    expect(core).toContain('source: claude-code');
    expect(core).toContain('session_id: sess-a');
    expect(core).toContain('帮我整理项目结构');
  });

  it('usage errors exit 2: unknown source, no mode, two modes at once', async () => {
    expect(await ingest(['--source', 'nope'])).toBe(2);
    expect(await ingest([])).toBe(2);
    expect(await ingest(['--source', 'codex', '--mark'])).toBe(2);
  });
});

describe('previously ingest --mark (estimate only)', () => {
  it('without --yes prints the plan and never dispatches the brain CLI', async () => {
    admitSlice(memoryRoot, mustParse(VALID_DOC), 'UTC'); // one dry slice
    const fixtureDir = join(home, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, 'reply.js');
    writeFileSync(fixture, replyFixtureScript('{"focus":"x","summary":"y","tags":["t"]}'), 'utf8');
    const marker = join(home, 'dispatched.marker');
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixture);
    process.env.FIXTURE_MARKER = marker;

    const code = await ingest(['--mark', '--agent', 'claude']);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Marking plan: 1 dry slice(s) → 1 model call(s) via claude');
    expect(stdout.join('\n')).toContain('Re-run with --yes');
    // No dispatch happened, and the slice is still dry.
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(corePath('2026-01-15-1430'), 'utf8')).not.toContain('focus:');
  });
});
