import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic.js';
import { parseSliceId, sliceIdToRelDir } from '../lib/slices.js';
import type { ScribeSource, SessionState, TranscriptEvent } from './types.js';

/**
 * Scribe-side slice writer. Produces the SAME on-disk layout the agent repo's
 * episodic manager produces (verified against `src/lib/episodic/manager.ts`
 * and live slices under `memory/episodic/slices/2026/`):
 *
 *   episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md   (frontmatter + turns)
 *   episodic/slices/YYYY/MM/DD/HHMM/timeline/agent.md  (cognition record)
 *   episodic/slices/YYYY/MM/DD/HHMM/timeline/appendix.md (unparseable lines)
 *   episodic/slices/YYYY/MM/_index.json                 (monthly manifest)
 *
 * Turn assembly: parsers emit a flat event stream; here it is grouped into
 * exchanges — a user message plus everything the agent did until the next
 * user message. core.md carries the conversation (one user Turn + one agent
 * Turn per exchange, sharing the exchange's turn id, like the kernel);
 * agent.md carries the process (one `## Cognition <turnId>` block per
 * exchange: `### Thinking` reasoning, `### Tools` one line per call with
 * its paired ok/error result).
 *
 * Everything here is deterministic: same events in → same bytes out. Re-writing
 * a slice whose content is unchanged is skipped byte-for-byte, so re-processing
 * (design doc §4: idempotent dedup by content hash) never churns the files.
 */

/** Slice identity is bound to the start moment: `YYYY-MM-DD-HHMM` in UTC. */
export function sliceIdFromTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot derive slice id from timestamp: ${isoTimestamp}`);
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}-${hh}${mm}`;
}

/** Minute-step a slice id, used to resolve same-minute collisions. */
function bumpSliceId(sliceId: string): string {
  const parts = parseSliceId(sliceId);
  if (parts === null || parts.hm === undefined) {
    throw new Error(`Cannot bump invalid slice id: ${sliceId}`);
  }
  const date = new Date(
    Date.UTC(Number(parts.y), Number(parts.m) - 1, Number(parts.d), Number(parts.hm.slice(0, 2)), Number(parts.hm.slice(2, 4)) + 1),
  );
  return sliceIdFromTimestamp(date.toISOString());
}

function sliceDir(memoryRoot: string, sliceId: string): string {
  const parts = parseSliceId(sliceId);
  if (parts === null || parts.hm === undefined) {
    throw new Error(`Invalid slice id: ${sliceId}`);
  }
  return join(memoryRoot, 'episodic', 'slices', ...sliceIdToRelDir(parts).split('/'));
}

function corePath(memoryRoot: string, sliceId: string): string {
  return join(sliceDir(memoryRoot, sliceId), 'timeline', 'core.md');
}

/** Read the owning session_id from an existing slice's core.md frontmatter. */
function sliceOwnerSessionId(memoryRoot: string, sliceId: string): string | null {
  const path = corePath(memoryRoot, sliceId);
  if (!existsSync(path)) return null;
  const head = readFileSync(path, 'utf8').slice(0, 4096);
  const match = /^session_id:\s*(.+)$/m.exec(head);
  return match ? match[1]!.trim().replace(/^'(.*)'$/, '$1') : null;
}

/**
 * Assign a collision-free slice id for a session. Two sessions starting in the
 * same minute (e.g. claude-code + codex, or two claude sessions) must not
 * overwrite each other — the later one steps forward a minute at a time until
 * it finds a free slot (or its own previous slot, on resume).
 */
export function resolveSliceId(
  memoryRoot: string,
  sessionId: string,
  firstTimestamp: string,
): string {
  let candidate = sliceIdFromTimestamp(firstTimestamp);
  for (let i = 0; i < 24 * 60; i++) {
    const owner = sliceOwnerSessionId(memoryRoot, candidate);
    if (owner === null || owner === sessionId) return candidate;
    candidate = bumpSliceId(candidate);
  }
  throw new Error(`No free slice id near ${firstTimestamp}`);
}

/** Deterministic 6-char base64url turn id (the kernel's are random; ours must
 *  be content-derived so a re-render produces byte-identical output). One id
 *  per exchange: the user/agent core blocks and the cognition block share it,
 *  which is how the kernel UI pairs them. */
function turnIdFor(source: ScribeSource, sessionId: string, index: number, exchange: Exchange): string {
  const anchor = exchange.user ?? exchange.agentEvents[0]!;
  const hash = createHash('sha256')
    .update(`${source}\n${sessionId}\n${index}\n${anchor.timestamp}\n${anchor.kind}\n${anchor.text}`)
    .digest();
  return hash.subarray(0, 4).toString('base64url').slice(0, 6);
}

/** YAML scalar for the narrow frontmatter shape we emit (strings/arrays only). */
export function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One conversational exchange: a user message plus every agent event until
 * the next user message. Agent events before the first user message (session
 * resumed mid-work, truncated logs) form a user-less leading exchange.
 */
export interface Exchange {
  user: TranscriptEvent | null;
  /** agent-text / thinking / tool-call / tool-result, in stream order. */
  agentEvents: TranscriptEvent[];
}

/** Group the flat event stream into exchanges (user message = boundary). */
export function assembleExchanges(events: TranscriptEvent[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  for (const event of events) {
    if (event.kind === 'user') {
      current = { user: event, agentEvents: [] };
      exchanges.push(current);
    } else {
      if (current === null) {
        current = { user: null, agentEvents: [] };
        exchanges.push(current);
      }
      current.agentEvents.push(event);
    }
  }
  return exchanges;
}

const TOOL_ERROR_EXCERPT_CAP = 200;

/** One `### Tools` line per call, paired with its result via toolCallId. */
function renderToolLines(exchange: Exchange): string[] {
  const lines: string[] = [];
  const usedResults = new Set<number>();
  const results = exchange.agentEvents.filter((e) => e.kind === 'tool-result');
  for (const event of exchange.agentEvents) {
    if (event.kind !== 'tool-call') continue;
    let status = '?';
    if (event.toolCallId !== undefined) {
      const idx = results.findIndex(
        (r, i) => !usedResults.has(i) && r.kind === 'tool-result' && r.toolCallId === event.toolCallId,
      );
      if (idx >= 0) {
        usedResults.add(idx);
        const result = results[idx]!;
        if (result.kind === 'tool-result') {
          status = result.isError
            ? `error: ${result.text.slice(0, TOOL_ERROR_EXCERPT_CAP)}`
            : 'ok';
        }
      }
    }
    lines.push(`- \`${event.toolName}\`(${event.text}) → ${status}`);
  }
  // Results with no matching call in this exchange (task notifications,
  // cross-turn results): render as standalone lines, never dropped.
  results.forEach((result, i) => {
    if (usedResults.has(i) || result.kind !== 'tool-result') return;
    const name = result.toolName ?? 'tool';
    const status = result.isError ? 'error' : 'ok';
    lines.push(`- \`${name}\` → ${status}${result.text !== '' ? `: ${result.text}` : ''}`);
  });
  return lines;
}

/**
 * Render a session's accumulated events as a kernel-shaped slice markdown
 * document. Mirrors the field set/order of the agent repo's serializeSlice
 * (empty focus/summary dropped), plus the scribe's `source` + `session_id`
 * provenance labels (design doc §5.3).
 */
export function renderSliceMarkdown(
  session: SessionState,
  sliceId: string,
  timezone: string,
): string {
  if (session.events.length === 0) {
    throw new Error('Refusing to render a slice with no events');
  }
  const start = session.events[0]!.timestamp;
  const lines = [
    '---',
    `slice_id: ${sliceId}`,
    'status: active',
    `start: '${start}'`,
    `timezone: ${yamlScalar(timezone)}`,
    `source: ${session.source}`,
    `session_id: ${yamlScalar(session.sessionId)}`,
    'open_loops: []',
    'decisions: []',
    'tags: []',
    'related_slices: []',
    'loops: []',
    '---',
  ];
  const exchanges = assembleExchanges(session.events);
  const blocks: string[] = [];
  exchanges.forEach((exchange, index) => {
    const id = turnIdFor(session.source, session.sessionId, index, exchange);
    if (exchange.user !== null) {
      blocks.push(`## Turn ${id} — ${exchange.user.timestamp} (user)\n\n${exchange.user.text}`);
    }
    const texts = exchange.agentEvents.filter((e) => e.kind === 'agent-text');
    if (texts.length > 0) {
      const last = texts[texts.length - 1]!;
      const body = texts.map((e) => e.text).join('\n\n');
      blocks.push(`## Turn ${id} — ${last.timestamp} (agent)\n\n${body}`);
    }
  });
  return lines.join('\n') + '\n' + blocks.join('\n\n') + '\n';
}

/**
 * Render the cognition record (`timeline/agent.md`) in the kernel's format:
 * one `## Cognition <turnId> — <ISO>` block per exchange, with `### Thinking`
 * (reasoning verbatim) and `### Tools` (one line per call → ok/error).
 * Returns null when the session produced no cognition at all — the caller
 * then ensures no agent.md exists (the kernel UI hides "thoughts" cleanly
 * only when the file is absent).
 */
export function renderAgentMarkdown(session: SessionState): string | null {
  const exchanges = assembleExchanges(session.events);
  const blocks: string[] = [];
  exchanges.forEach((exchange, index) => {
    const thinkings = exchange.agentEvents.filter((e) => e.kind === 'thinking');
    const toolLines = renderToolLines(exchange);
    if (thinkings.length === 0 && toolLines.length === 0) return;
    const id = turnIdFor(session.source, session.sessionId, index, exchange);
    const anchor = exchange.agentEvents[0] ?? exchange.user!;
    const sections: string[] = [];
    if (thinkings.length > 0) {
      sections.push(`### Thinking\n\n${thinkings.map((e) => e.text).join('\n\n')}`);
    }
    if (toolLines.length > 0) {
      sections.push(`### Tools\n\n${toolLines.join('\n')}`);
    }
    blocks.push(`## Cognition ${id} — ${anchor.timestamp}\n\n${sections.join('\n\n')}`);
  });
  if (blocks.length === 0) return null;
  return blocks.join('\n\n') + '\n';
}

/** Render the appendix file holding raw lines that failed to parse (§5.3). */
export function renderAppendixMarkdown(session: SessionState, sliceId: string): string {
  const lines = [
    '---',
    `slice_id: ${sliceId}`,
    `source: ${session.source}`,
    `session_id: ${yamlScalar(session.sessionId)}`,
    '---',
    '# Appendix — lines the scribe could not parse',
    '',
    'Preserved verbatim (format tax, design doc §5.3). Counted as parse errors in scribe status.',
    '',
    '````jsonl',
    ...session.appendix,
    '````',
    '',
  ];
  return lines.join('\n');
}

/** One entry in the monthly manifest, mirroring the agent repo's
 *  SliceIndexEntry plus the scribe provenance labels. `source` is a free-form
 *  provenance label: one of the ScribeSource values for transcribed logs,
 *  anything the caller declared for externally submitted slices (ingest). */
export interface ScribeIndexEntry {
  id: string;
  focus: string;
  summary: string;
  tags: string[];
  status: 'active' | 'closed';
  start: string;
  open_loops: string[];
  decisions: string[];
  source: string;
  sessionId: string;
}

interface MonthlyIndex {
  month: string;
  slices: ScribeIndexEntry[];
}

export function toIndexEntry(session: SessionState, sliceId: string): ScribeIndexEntry {
  return {
    id: sliceId,
    focus: '',
    summary: '',
    tags: [],
    status: 'active',
    start: session.events[0]!.timestamp,
    open_loops: [],
    decisions: [],
    source: session.source,
    sessionId: session.sessionId,
  };
}

/**
 * Upsert a slice entry into `episodic/slices/YYYY/MM/_index.json`, mirroring
 * the agent repo's updateMonthlyIndex: replace-by-id or append, sort by id
 * ascending, write only when the serialized bytes change. A corrupt existing
 * index is an honest error (thrown), never silently overwritten.
 */
export function upsertMonthlyIndex(memoryRoot: string, entry: ScribeIndexEntry): boolean {
  const parts = parseSliceId(entry.id);
  if (parts === null || parts.hm === undefined) throw new Error(`Invalid slice id: ${entry.id}`);
  const indexDir = join(memoryRoot, 'episodic', 'slices', parts.y, parts.m);
  const indexPath = join(indexDir, '_index.json');

  let slices: ScribeIndexEntry[] = [];
  let existingBytes: string | null = null;
  if (existsSync(indexPath)) {
    existingBytes = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(existingBytes) as MonthlyIndex;
    if (typeof parsed.month !== 'string' || !Array.isArray(parsed.slices)) {
      throw new Error(`Unrecognized _index.json shape at ${indexPath}`);
    }
    slices = parsed.slices;
  }

  const idx = slices.findIndex((e) => e.id === entry.id);
  if (idx >= 0) slices[idx] = entry;
  else slices.push(entry);
  slices.sort((a, b) => a.id.localeCompare(b.id));

  const month = `${parts.y}-${parts.m}`;
  const json = JSON.stringify({ month, slices } satisfies MonthlyIndex, null, 2) + '\n';
  if (json === existingBytes) return false;
  mkdirSync(indexDir, { recursive: true });
  writeFileAtomic(indexPath, json);
  return true;
}

export interface SliceWriteResult {
  sliceId: string;
  sliceDir: string;
  /** True when core.md bytes changed on disk. */
  coreChanged: boolean;
  /** True when the monthly index changed on disk. */
  indexChanged: boolean;
}

/**
 * Write (or byte-identically skip) the session's slice: core.md rewritten from
 * the accumulated events, appendix.md when there are unparseable lines, and
 * the monthly manifest entry.
 */
export function writeSessionSlice(
  memoryRoot: string,
  session: SessionState,
  timezone: string,
): SliceWriteResult {
  if (session.sliceId === null) {
    throw new Error('Session has no slice id yet (no parseable events seen)');
  }
  const sliceId = session.sliceId;
  const dir = join(sliceDir(memoryRoot, sliceId), 'timeline');
  mkdirSync(dir, { recursive: true });

  const core = join(dir, 'core.md');
  const rendered = renderSliceMarkdown(session, sliceId, timezone);
  const coreChanged = !existsSync(core) || readFileSync(core, 'utf8') !== rendered;
  if (coreChanged) writeFileAtomic(core, rendered);

  // Cognition record: written when the session produced any, REMOVED when a
  // re-render yields none (stale files from earlier parser versions must not
  // linger — the kernel UI treats an absent agent.md as "no thoughts").
  const agentPath = join(dir, 'agent.md');
  const agentRendered = renderAgentMarkdown(session);
  if (agentRendered !== null) {
    if (!existsSync(agentPath) || readFileSync(agentPath, 'utf8') !== agentRendered) {
      writeFileAtomic(agentPath, agentRendered);
    }
  } else if (existsSync(agentPath)) {
    rmSync(agentPath, { force: true });
  }

  if (session.appendix.length > 0) {
    const appendix = join(dir, 'appendix.md');
    const renderedAppendix = renderAppendixMarkdown(session, sliceId);
    if (!existsSync(appendix) || readFileSync(appendix, 'utf8') !== renderedAppendix) {
      writeFileAtomic(appendix, renderedAppendix);
    }
  }

  const indexChanged = upsertMonthlyIndex(memoryRoot, toIndexEntry(session, sliceId));
  return { sliceId, sliceDir: dir, coreChanged, indexChanged };
}
