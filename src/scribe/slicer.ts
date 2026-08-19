import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 *   episodic/slices/YYYY/MM/DD/HHMM/timeline/appendix.md (unparseable lines)
 *   episodic/slices/YYYY/MM/_index.json                 (monthly manifest)
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
 *  be content-derived so a re-render produces byte-identical output). */
function turnIdFor(source: ScribeSource, sessionId: string, index: number, event: TranscriptEvent): string {
  const hash = createHash('sha256')
    .update(`${source}\n${sessionId}\n${index}\n${event.timestamp}\n${event.role}\n${event.toolName ?? ''}\n${event.text}`)
    .digest();
  return hash.subarray(0, 4).toString('base64url').slice(0, 6);
}

/** YAML scalar for the narrow frontmatter shape we emit (strings/arrays only). */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
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
  const turns = session.events.map((event, index) => {
    const id = turnIdFor(session.source, session.sessionId, index, event);
    const body = event.toolName !== undefined ? `**Tool: ${event.toolName}**\n\n${event.text}` : event.text;
    return `## Turn ${id} — ${event.timestamp} (${event.role})\n\n${body}`;
  });
  return lines.join('\n') + '\n' + turns.join('\n\n') + '\n';
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
 *  SliceIndexEntry plus the scribe provenance labels. */
export interface ScribeIndexEntry {
  id: string;
  focus: string;
  summary: string;
  tags: string[];
  status: 'active' | 'closed';
  start: string;
  open_loops: string[];
  decisions: string[];
  source: ScribeSource;
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
