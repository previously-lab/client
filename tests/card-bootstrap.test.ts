import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as card } from '../src/commands/card.js';
import {
  CARD_TOTAL_CAP,
  collectCardContext,
  emptyCard,
  validateCardDocument,
} from '../src/lib/cardgen.js';
import { admitSlice, parseSubmittedSlice, type SubmittedSlice } from '../src/lib/ingest.js';
import { sliceIdFromTimestamp, type ScribeIndexEntry } from '../src/scribe/slicer.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, replyFixtureScript } from './bridge-fixtures.js';

/**
 * Card bootstrap tests, fully sandboxed: PREVIOUSLY_HOME is a temp dir and
 * the brain CLI is a fixture injected via PREVIOUSLY_BRIDGE_CLAUDE_CMD. The
 * reader side (`previously card [--slice]`) is covered by card.test.ts.
 */

let home: string;
let memoryRoot: string;
let cardPath: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = useTempHome();
  memoryRoot = join(home, 'memory');
  cardPath = join(memoryRoot, 'episodic', 'current-previously.md');
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

/** Submit + admit one dry slice whose start minute is `start`'s. */
function submitDrySlice(start: Date, sessionId: string, firstLine: string): SubmittedSlice {
  const startIso = start.toISOString();
  const sliceId = sliceIdFromTimestamp(startIso);
  const doc = [
    '---',
    `slice_id: ${sliceId}`,
    'status: closed',
    `start: '${startIso}'`,
    `end: '${new Date(start.getTime() + 60_000).toISOString()}'`,
    'source: claude-code',
    `session_id: ${sessionId}`,
    'tags: []',
    '---',
    `## Turn t1 — ${startIso} (user)`,
    '',
    firstLine,
    '',
    `## Turn t2 — ${new Date(start.getTime() + 30_000).toISOString()} (agent)`,
    '',
    '好的。',
    '',
  ].join('\n');
  const { slice, issues } = parseSubmittedSlice(doc);
  if (slice === null) throw new Error(`fixture doc rejected: ${JSON.stringify(issues)}`);
  admitSlice(memoryRoot, slice, 'UTC');
  return slice;
}

/** Point the claude bridge at a fixture CLI that replies with `reply`. Returns the marker path. */
function useReplyFixture(reply: string): string {
  const fixtureDir = join(home, 'fixtures');
  mkdirSync(fixtureDir, { recursive: true });
  const fixture = join(fixtureDir, 'reply.js');
  writeFileSync(fixture, replyFixtureScript(reply), 'utf8');
  process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixture);
  const marker = join(home, 'dispatched.marker');
  process.env.FIXTURE_MARKER = marker;
  return marker;
}

const VALID_CARD_REPLY = [
  '# Previously On',
  '',
  '_Format: user card v2 | Updated: 2000-01-01T00:00:00.000Z_',
  '',
  '## Identity',
  '- Test user — refs: [2026/08/10/1401]',
  '',
  '## Past',
  '',
  '## Now',
  '- Bootstrapping the card — refs: [2026/08/10/1401] | since: 2026-08-10',
  '',
  '## Horizon',
  '',
  '## Self-model',
  '',
].join('\n');

describe('previously card bootstrap --empty', () => {
  it('writes the empty card skeleton at zero cost', async () => {
    const code = await card(['bootstrap', '--empty']);
    expect(code).toBe(0);
    const content = readFileSync(cardPath, 'utf8');
    expect(content.startsWith('# Previously On')).toBe(true);
    for (const section of ['## Identity', '## Past', '## Now', '## Horizon', '## Self-model']) {
      expect(content).toContain(section);
    }
    expect(stdout.join('\n')).toContain('Zero token cost');
  });

  it('refuses to overwrite a non-empty card unless --force (which backs up first)', async () => {
    mkdirSync(dirname(cardPath), { recursive: true });
    writeFileSync(cardPath, '# Previously On\n\n- my precious hand-written card\n', 'utf8');

    expect(await card(['bootstrap', '--empty'])).toBe(1);
    expect(stderr.join('\n')).toContain('--force');
    expect(readFileSync(cardPath, 'utf8')).toContain('my precious hand-written card');

    expect(await card(['bootstrap', '--empty', '--force'])).toBe(0);
    expect(readFileSync(cardPath, 'utf8')).toContain('## Identity');
    expect(readFileSync(`${cardPath}.bak`, 'utf8')).toContain('my precious hand-written card');
  });

  it('re-running --empty over our own skeleton is allowed (idempotent scope)', async () => {
    expect(await card(['bootstrap', '--empty'])).toBe(0);
    expect(await card(['bootstrap', '--empty'])).toBe(0);
    expect(readFileSync(cardPath, 'utf8')).toContain('## Identity');
  });
});

describe('previously card bootstrap (estimate-first spending)', () => {
  it('default window without --yes prints the estimate, exits 0, and dispatches nothing', async () => {
    submitDrySlice(new Date(), 'sess-now', '最近在做什么');
    const marker = useReplyFixture(VALID_CARD_REPLY);

    const code = await card(['bootstrap', '--agent', 'claude']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('Card bootstrap plan: 1 slice(s)');
    expect(out).toContain('Re-run with --yes');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(cardPath)).toBe(false);
  });

  it('--full without --yes warns about the token-heavy call and dispatches nothing', async () => {
    submitDrySlice(new Date('2026-01-15T14:30:12.000Z'), 'sess-old', '一月的旧事');
    const marker = useReplyFixture(VALID_CARD_REPLY);

    const code = await card(['bootstrap', '--full', '--agent', 'claude']);
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('ENTIRE archived history');
    expect(out).toContain('WARNING: --full');
    expect(existsSync(marker)).toBe(false);
  });

  it('--yes runs one call via the fixture CLI and writes the normalized card', async () => {
    submitDrySlice(new Date(), 'sess-now', '最近在做什么');
    const marker = useReplyFixture(VALID_CARD_REPLY);

    const code = await card(['bootstrap', '--agent', 'claude', '--yes']);
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(stdout.join('\n')).toContain('Card written:');

    const content = readFileSync(cardPath, 'utf8');
    expect(content.startsWith('# Previously On')).toBe(true);
    expect(content).toContain('## Self-model');
    // The meta line is normalized: our stamp replaces the model's.
    expect(content).not.toContain('2000-01-01');
    const meta = content.split('\n').find((l) => l.startsWith('_') && l.endsWith('_'));
    expect(meta).toMatch(/^_Format: user card v2 \| Updated: .+_$/);
  });

  it('a fixture reply missing required sections is rejected: exit 1, nothing written', async () => {
    submitDrySlice(new Date(), 'sess-now', '最近在做什么');
    useReplyFixture('# Previously On\n\n## Identity\n- only this section\n');

    const code = await card(['bootstrap', '--agent', 'claude', '--yes']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('not a valid card');
    expect(existsSync(cardPath)).toBe(false);
  });

  it('bootstrap with nothing in scope is an honest exit 1', async () => {
    const code = await card(['bootstrap', '--agent', 'claude']);
    expect(code).toBe(1);
    expect(stdout.join('\n')).toContain('Nothing in scope');
  });
});

describe('collectCardContext', () => {
  function writeMonthlyIndex(entries: ScribeIndexEntry[]): void {
    const indexDir = join(memoryRoot, 'episodic', 'slices', '2026', '08');
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, '_index.json'), JSON.stringify({ month: '2026-08', slices: entries }, null, 2) + '\n', 'utf8');
  }

  function indexEntry(id: string, start: string, extra: Partial<ScribeIndexEntry> = {}): ScribeIndexEntry {
    return {
      id,
      focus: '',
      summary: '',
      tags: [],
      status: 'closed',
      start,
      open_loops: [],
      decisions: [],
      source: 'test',
      sessionId: `s-${id}`,
      ...extra,
    };
  }

  it('sinceMs filters out slices that started before the window', () => {
    writeMonthlyIndex([
      indexEntry('2026-08-01-1000', '2026-08-01T10:00:00.000Z', { summary: '八月一号' }),
      indexEntry('2026-08-10-1401', '2026-08-10T14:01:00.000Z', { summary: '八月十号' }),
    ]);
    const { entries } = collectCardContext(memoryRoot, Date.parse('2026-08-05T00:00:00.000Z'));
    expect(entries.map((e) => e.sliceId)).toEqual(['2026-08-10-1401']);
  });

  it('marked slices use focus — summary; dry slices fall back to the first user line', () => {
    writeMonthlyIndex([
      indexEntry('2026-08-10-1401', '2026-08-10T14:01:00.000Z', { focus: '面试准备', summary: '准备了面试' }),
      indexEntry('2026-08-11-0900', '2026-08-11T09:00:00.000Z'),
    ]);
    // The dry slice needs a core.md for the first-line fallback.
    const coreDir = join(memoryRoot, 'episodic', 'slices', '2026', '08', '11', '0900', 'timeline');
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(
      join(coreDir, 'core.md'),
      [
        '---',
        'slice_id: 2026-08-11-0900',
        'status: closed',
        '---',
        '## Turn t1 — 2026-08-11T09:00:00.000Z (user)',
        '',
        'dry slice 的第一句用户消息',
        '',
      ].join('\n'),
      'utf8',
    );

    const { entries } = collectCardContext(memoryRoot, null);
    expect(entries.length).toBe(2);
    const marked = entries.find((e) => e.sliceId === '2026-08-10-1401')!;
    expect(marked.marked).toBe(true);
    expect(marked.line).toBe('面试准备 — 准备了面试');
    const dry = entries.find((e) => e.sliceId === '2026-08-11-0900')!;
    expect(dry.marked).toBe(false);
    expect(dry.line).toBe('dry slice 的第一句用户消息');
  });

  it('caps the total context, keeping the MOST RECENT entries', () => {
    // 10 entries × (2000-char focus + 40) ≈ 20 400 chars > 12 000 cap → 5 kept.
    const entries: ScribeIndexEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const hm = `14${String(i).padStart(2, '0')}`;
      entries.push(
        indexEntry(`2026-08-10-${hm}`, `2026-08-10T14:${String(i).padStart(2, '0')}:00.000Z`, {
          focus: 'x'.repeat(2000),
        }),
      );
    }
    writeMonthlyIndex(entries);

    const { entries: kept, totalSlices } = collectCardContext(memoryRoot, null);
    expect(totalSlices).toBe(10);
    expect(kept.length).toBe(5);
    expect(kept.map((e) => e.sliceId)).toEqual([
      '2026-08-10-1405',
      '2026-08-10-1406',
      '2026-08-10-1407',
      '2026-08-10-1408',
      '2026-08-10-1409',
    ]);
  });
});

describe('validateCardDocument', () => {
  it('strips a single whole-reply fence and normalizes the meta line', () => {
    const fenced = `\`\`\`markdown\n${VALID_CARD_REPLY}\n\`\`\``;
    const { card, error } = validateCardDocument(fenced);
    expect(error).toBeNull();
    expect(card).not.toBeNull();
    expect(card!.startsWith('# Previously On')).toBe(true);
    expect(card!).not.toContain('```');
    expect(card!).not.toContain('2000-01-01');
    expect(card!).toContain('_Format: user card v2 | Updated:');
  });

  it('rejects a reply missing a required section', () => {
    const { card, error } = validateCardDocument('# Previously On\n\n## Identity\n- x\n');
    expect(card).toBeNull();
    expect(error).toContain('## Past');
  });

  it('rejects a reply over the total cap', () => {
    const big = VALID_CARD_REPLY.replace('## Self-model', `- ${'x'.repeat(CARD_TOTAL_CAP)}\n\n## Self-model`);
    const { card, error } = validateCardDocument(big);
    expect(card).toBeNull();
    expect(error).toContain(`${CARD_TOTAL_CAP}-char cap`);
  });

  it('rejects a reply that does not start with the card title', () => {
    const { card, error } = validateCardDocument('Here is the card you asked for:\n\n# Previously On\n\n## Identity\n');
    expect(card).toBeNull();
    expect(error).toContain('# Previously On');
  });
});

describe('emptyCard', () => {
  it('is a valid card skeleton (passes validateCardDocument)', () => {
    const { card, error } = validateCardDocument(emptyCard());
    expect(error).toBeNull();
    expect(card).not.toBeNull();
  });
});
