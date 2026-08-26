import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSliceId, sliceIdToRelDir } from './slices.js';
import { writeFileAtomic } from './atomic.js';
import { SCRIBE_SOURCES } from '../scribe/types.js';
import {
  sliceIdFromTimestamp,
  upsertMonthlyIndex,
  yamlScalar,
  type ScribeIndexEntry,
} from '../scribe/slicer.js';

/**
 * External slice ingestion (the "write" path for other agents): a caller hands
 * us a COMPLETE rendered slice document — we validate it against the kernel's
 * slice contract and, only when it passes, write it to disk ourselves. Callers
 * never write the memory directory directly.
 *
 * Design rules (see the ingest skill doc):
 * - Submitted slices are historical records: status must be `closed`.
 * - focus/summary/tags MAY be empty ("dry"); the kernel's backfill-marks or
 *   `previously ingest --mark` fills them later.
 * - Ingested slices never touch the Previously card and never get an
 *   agent.md / previously.md — those belong to live sessions.
 * - Dedup by (source, session_id): re-submitting identical bytes is a no-op;
 *   same session with different content is a hard conflict, never an
 *   overwrite.
 */

export interface SubmittedTurn {
  id: string;
  timestamp: string;
  role: 'user' | 'agent';
  body: string;
}

export interface SubmittedSlice {
  sliceId: string;
  start: string;
  end: string;
  timezone: string | null;
  source: string;
  sessionId: string;
  focus: string;
  summary: string;
  tags: string[];
  emotionalTone: string | null;
  turns: SubmittedTurn[];
}

export interface ValidationIssue {
  /** Dotted location, e.g. "frontmatter.start" or "turns[2].timestamp". */
  path: string;
  message: string;
}

export class IngestError extends Error {
  constructor(
    readonly issues: ValidationIssue[],
    message: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

const TURN_HEADER = /^## Turn (\S+) — (\S+) \((user|agent)\)\s*$/;
const TURN_ID = /^[A-Za-z0-9_-]{1,16}$/;
/** Frontmatter keys we understand and re-emit; anything else is dropped. */
const KNOWN_KEYS = new Set([
  'slice_id',
  'focus',
  'status',
  'start',
  'end',
  'timezone',
  'source',
  'session_id',
  'summary',
  'tags',
  'emotional_tone',
  'closed_by',
  // Kernel/scribe fields we accept but always re-emit as empty:
  'open_loops',
  'decisions',
  'related_slices',
  'loops',
  'evolution_summary',
]);

function isValidIso(value: string): boolean {
  return value.includes('T') && !Number.isNaN(new Date(value).getTime());
}

/** Unquote a YAML single/double-quoted scalar; returns null when malformed. */
function unquote(raw: string): string | null {
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return null;
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Parse a single-line flow array (`[]`, `[a, b]`, `['a', "b"]`). */
function parseFlowArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[] = [];
  // Split on commas that are not inside quotes.
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote !== null) {
      cur += ch;
      if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          cur += inner[++i];
        } else {
          quote = null;
        }
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  if (quote !== null) return null; // unterminated quote
  const items: string[] = [];
  for (const part of out) {
    const value = unquote(part.trim());
    if (value === null || value.trim() === '') return null;
    items.push(value);
  }
  return items;
}

interface RawFrontmatter {
  scalars: Map<string, string>;
  arrays: Map<string, string[]>;
  dropped: string[];
  issues: ValidationIssue[];
}

/** Minimal line-based YAML reader for exactly the slice frontmatter shape. */
function parseFrontmatter(lines: string[]): RawFrontmatter {
  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  const dropped: string[] = [];
  const issues: ValidationIssue[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (match === null) {
      issues.push({
        path: 'frontmatter',
        message: `Unparseable frontmatter line (block scalars like "key: >-" are not accepted; use single-line values): ${line.slice(0, 80)}`,
      });
      continue;
    }
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (!KNOWN_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    const value = rawValue.trim();
    if (/^(>-?|\|-?)$/.test(value)) {
      issues.push({
        path: `frontmatter.${key}`,
        message: `Block scalars ("${value}") are not accepted; use a single-line value`,
      });
      continue;
    }
    if (value.startsWith('[')) {
      const arr = parseFlowArray(value);
      if (arr === null) {
        issues.push({ path: `frontmatter.${key}`, message: `Malformed flow array: ${value.slice(0, 80)}` });
      } else {
        arrays.set(key, arr);
      }
      continue;
    }
    const scalar = unquote(value);
    if (scalar === null) {
      issues.push({ path: `frontmatter.${key}`, message: `Malformed quoted scalar: ${value.slice(0, 80)}` });
      continue;
    }
    scalars.set(key, scalar);
  }
  return { scalars, arrays, dropped, issues };
}

export interface ParseResult {
  slice: SubmittedSlice | null;
  issues: ValidationIssue[];
  /** Unknown frontmatter keys that would be dropped by canonical re-rendering. */
  dropped: string[];
}

/**
 * Parse and strictly validate one submitted slice document. Returns either a
 * fully-validated slice (issues may still hold non-fatal notes — currently
 * none) or null + the complete issue list. Nothing is written here.
 */
export function parseSubmittedSlice(doc: string): ParseResult {
  const issues: ValidationIssue[] = [];
  const lines = doc.replace(/^﻿/, '').split(/\r?\n/);

  if (lines[0] !== '---') {
    return {
      slice: null,
      issues: [{ path: 'frontmatter', message: 'Document must start with a YAML frontmatter block (a "---" line)' }],
      dropped: [],
    };
  }
  const fmEnd = lines.indexOf('---', 1);
  if (fmEnd < 0) {
    return {
      slice: null,
      issues: [{ path: 'frontmatter', message: 'Unterminated frontmatter block (missing closing "---" line)' }],
      dropped: [],
    };
  }

  const fm = parseFrontmatter(lines.slice(1, fmEnd));
  issues.push(...fm.issues);

  const sliceId = fm.scalars.get('slice_id') ?? '';
  if (sliceId === '') {
    issues.push({ path: 'frontmatter.slice_id', message: 'Missing required field: slice_id (YYYY-MM-DD-HHMM)' });
  } else if (parseSliceId(sliceId)?.hm === undefined) {
    issues.push({
      path: 'frontmatter.slice_id',
      message: `Invalid slice_id: ${JSON.stringify(sliceId)} — expected YYYY-MM-DD-HHMM with plausible calendar values`,
    });
  }

  const status = fm.scalars.get('status') ?? '';
  if (status !== 'closed') {
    issues.push({
      path: 'frontmatter.status',
      message: `status must be "closed" for ingested slices (historical records; got ${JSON.stringify(status || '(missing)')})`,
    });
  }

  const start = fm.scalars.get('start') ?? '';
  if (!isValidIso(start)) {
    issues.push({ path: 'frontmatter.start', message: `start must be an ISO 8601 timestamp, got: ${JSON.stringify(start || '(missing)')}` });
  }
  const end = fm.scalars.get('end') ?? '';
  if (!isValidIso(end)) {
    issues.push({ path: 'frontmatter.end', message: `end must be an ISO 8601 timestamp (closed slices need one), got: ${JSON.stringify(end || '(missing)')}` });
  } else if (isValidIso(start) && Date.parse(end) < Date.parse(start)) {
    issues.push({ path: 'frontmatter.end', message: `end (${end}) is before start (${start})` });
  }

  // Slice identity is bound to the start moment.
  if (isValidIso(start) && parseSliceId(sliceId)?.hm !== undefined) {
    const expected = sliceIdFromTimestamp(start);
    if (expected !== sliceId) {
      issues.push({
        path: 'frontmatter.slice_id',
        message: `slice_id ${sliceId} does not match start ${start} (identity is start-time-bound; expected ${expected})`,
      });
    }
  }

  const source = fm.scalars.get('source') ?? '';
  if (source.trim() === '') {
    issues.push({ path: 'frontmatter.source', message: 'Missing required field: source (provenance label, e.g. "claude-code" or "custom")' });
  }
  const sessionId = fm.scalars.get('session_id') ?? '';
  if (sessionId.trim() === '') {
    issues.push({ path: 'frontmatter.session_id', message: 'Missing required field: session_id (provenance label used for dedup)' });
  }

  const focus = fm.scalars.get('focus') ?? '';
  const summary = fm.scalars.get('summary') ?? '';
  const tags = fm.arrays.get('tags') ?? [];
  if (fm.scalars.has('tags')) {
    issues.push({ path: 'frontmatter.tags', message: 'tags must be a flow array: tags: [a, b] or tags: []' });
  }
  const emotionalTone = fm.scalars.get('emotional_tone') ?? null;

  // Body: turn blocks.
  const bodyLines = lines.slice(fmEnd + 1);
  const turns: SubmittedTurn[] = [];
  let current: { id: string; timestamp: string; role: 'user' | 'agent'; bodyLines: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    turns.push({
      id: current.id,
      timestamp: current.timestamp,
      role: current.role,
      body: current.bodyLines.join('\n').replace(/^\n+|\n+$/g, ''),
    });
    current = null;
  };
  let preamble = true;
  for (const line of bodyLines) {
    const header = TURN_HEADER.exec(line);
    if (header !== null) {
      flush();
      preamble = false;
      current = { id: header[1]!, timestamp: header[2]!, role: header[3] as 'user' | 'agent', bodyLines: [] };
    } else if (current !== null) {
      current.bodyLines.push(line);
    } else if (preamble && line.trim() !== '') {
      issues.push({ path: 'body', message: `Content before the first "## Turn" header: ${line.slice(0, 60)}` });
      preamble = false;
    }
  }
  flush();

  if (turns.length === 0 && !issues.some((i) => i.path === 'body')) {
    issues.push({ path: 'body', message: 'No turn blocks found (expected at least one "## Turn <id> — <ISO timestamp> (user|agent)")' });
  }
  let prevTs = -Infinity;
  turns.forEach((turn, i) => {
    if (!TURN_ID.test(turn.id)) {
      issues.push({ path: `turns[${i}].id`, message: `Turn id ${JSON.stringify(turn.id)} must be 1-16 chars of A-Za-z0-9_-` });
    }
    if (!isValidIso(turn.timestamp)) {
      issues.push({ path: `turns[${i}].timestamp`, message: `Invalid timestamp: ${JSON.stringify(turn.timestamp)}` });
    } else {
      const ts = Date.parse(turn.timestamp);
      if (ts < prevTs) {
        issues.push({ path: `turns[${i}].timestamp`, message: `Turns must be in non-decreasing time order (${turn.timestamp} follows an earlier-labeled turn)` });
      }
      prevTs = ts;
    }
    if (turn.body.trim() === '') {
      issues.push({ path: `turns[${i}].body`, message: `Turn ${turn.id} has an empty body` });
    }
  });

  if (issues.length > 0) return { slice: null, issues, dropped: fm.dropped };
  return {
    slice: {
      sliceId,
      start,
      end,
      timezone: fm.scalars.get('timezone') ?? null,
      source,
      sessionId,
      focus,
      summary,
      tags,
      emotionalTone,
      turns,
    },
    issues: [],
    dropped: fm.dropped,
  };
}

/** YAML flow array for the narrow shapes we emit (plain string arrays). */
function yamlFlowArray(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => yamlScalar(v)).join(', ')}]`;
}

/**
 * Canonical on-disk rendering of a validated submission. We re-render rather
 * than writing the caller's bytes verbatim: field set/order follows the
 * kernel's serializeSlice (plus scribe provenance labels), so the memory
 * directory always carries OUR byte shape no matter who drafted the document.
 */
export function renderSubmittedSlice(slice: SubmittedSlice, timezone: string): string {
  const lines = [
    '---',
    `slice_id: ${slice.sliceId}`,
    ...(slice.focus !== '' ? [`focus: ${yamlScalar(slice.focus)}`] : []),
    'status: closed',
    `start: '${slice.start}'`,
    `end: '${slice.end}'`,
    `timezone: ${yamlScalar(slice.timezone ?? timezone)}`,
    `source: ${yamlScalar(slice.source)}`,
    `session_id: ${yamlScalar(slice.sessionId)}`,
    ...(slice.summary !== '' ? [`summary: ${yamlScalar(slice.summary)}`] : []),
    'open_loops: []',
    'decisions: []',
    `tags: ${yamlFlowArray(slice.tags)}`,
    'related_slices: []',
    'loops: []',
    ...(slice.emotionalTone !== null && slice.emotionalTone !== '' ? [`emotional_tone: ${yamlScalar(slice.emotionalTone)}`] : []),
    'closed_by: user_explicit',
    '---',
  ];
  const turns = slice.turns.map(
    (turn) => `## Turn ${turn.id} — ${turn.timestamp} (${turn.role})\n\n${turn.body}`,
  );
  return lines.join('\n') + '\n' + turns.join('\n\n') + '\n';
}

function sliceDirFor(memoryRoot: string, sliceId: string): string {
  const parts = parseSliceId(sliceId);
  if (parts === null || parts.hm === undefined) throw new Error(`Invalid slice id: ${sliceId}`);
  return join(memoryRoot, 'episodic', 'slices', ...sliceIdToRelDir(parts).split('/'));
}

/** Walk monthly manifests looking for an entry carrying this (source, sessionId). */
export function findIngestedSlice(
  memoryRoot: string,
  source: string,
  sessionId: string,
): ScribeIndexEntry | null {
  const slicesRoot = join(memoryRoot, 'episodic', 'slices');
  if (!existsSync(slicesRoot)) return null;
  for (const y of readdirSync(slicesRoot)) {
    const yDir = join(slicesRoot, y);
    if (!/^\d{4}$/.test(y)) continue;
    let months: string[];
    try {
      months = readdirSync(yDir);
    } catch {
      continue;
    }
    for (const m of months) {
      const indexPath = join(yDir, m, '_index.json');
      if (!existsSync(indexPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { slices?: ScribeIndexEntry[] };
        for (const entry of parsed.slices ?? []) {
          if (entry.source === source && entry.sessionId === sessionId) return entry;
        }
      } catch {
        continue; // A corrupt index elsewhere must not block ingestion.
      }
    }
  }
  return null;
}

export interface AdmitResult {
  action: 'written' | 'duplicate';
  sliceId: string;
  path: string;
  /** Set when the requested id was taken by another session and we stepped forward. */
  remappedFrom: string | null;
}

/**
 * Count the scribe-derived slices currently in memory (entries carrying one of
 * the four scribe sources). Used by `init` to guide the user when content
 * already exists.
 */
export function countScribeSlices(memoryRoot: string): number {
  const slicesRoot = join(memoryRoot, 'episodic', 'slices');
  if (!existsSync(slicesRoot)) return 0;
  let count = 0;
  for (const y of readdirSync(slicesRoot)) {
    if (!/^\d{4}$/.test(y)) continue;
    let months: string[];
    try {
      months = readdirSync(join(slicesRoot, y));
    } catch {
      continue;
    }
    for (const m of months) {
      const indexPath = join(slicesRoot, y, m, '_index.json');
      if (!existsSync(indexPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { slices?: ScribeIndexEntry[] };
        for (const entry of parsed.slices ?? []) {
          if ((SCRIBE_SOURCES as readonly string[]).includes(entry.source)) count++;
        }
      } catch {
        continue;
      }
    }
  }
  return count;
}

export interface PurgeResult {
  removedIds: string[];
}

/**
 * Remove all RE-DERIVABLE slices: those transcribed by the scribe from raw
 * agent logs (source ∈ SCRIBE_SOURCES). With `includeCustom`, also removes
 * externally submitted slices (any entry carrying a source/sessionId label).
 * Kernel-produced slices (Previously's own conversations) carry no source
 * label and are NEVER touched — they are the primary record, not derivable.
 * Monthly manifests are rewritten without the removed entries; emptied date
 * dirs are pruned. Anything not listed in a manifest is left alone.
 */
export function purgeDerivedSlices(memoryRoot: string, includeCustom: boolean): PurgeResult {
  const slicesRoot = join(memoryRoot, 'episodic', 'slices');
  const removedIds: string[] = [];
  if (!existsSync(slicesRoot)) return { removedIds };

  for (const y of readdirSync(slicesRoot)) {
    if (!/^\d{4}$/.test(y)) continue;
    const yDir = join(slicesRoot, y);
    let months: string[];
    try {
      months = readdirSync(yDir);
    } catch {
      continue;
    }
    for (const m of months) {
      const mDir = join(yDir, m);
      const indexPath = join(mDir, '_index.json');
      if (!existsSync(indexPath)) continue;
      let parsed: { month: string; slices: ScribeIndexEntry[] };
      try {
        parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { month: string; slices: ScribeIndexEntry[] };
      } catch {
        continue; // corrupt manifest: refuse to guess, leave everything
      }
      const keep: ScribeIndexEntry[] = [];
      for (const entry of parsed.slices ?? []) {
        const isScribe = (SCRIBE_SOURCES as readonly string[]).includes(entry.source);
        const isCustom = !isScribe && typeof entry.source === 'string' && entry.source !== '';
        if (isScribe || (includeCustom && isCustom)) {
          const parts = parseSliceId(entry.id);
          if (parts !== null) {
            const dir = join(slicesRoot, ...sliceIdToRelDir(parts).split('/'));
            rmSync(dir, { recursive: true, force: true });
          }
          removedIds.push(entry.id);
        } else {
          keep.push(entry);
        }
      }
      if (removedIds.length > 0 && keep.length !== (parsed.slices ?? []).length) {
        if (keep.length === 0) rmSync(indexPath, { force: true });
        else writeFileAtomic(indexPath, JSON.stringify({ month: parsed.month, slices: keep }, null, 2) + '\n');
      }
      // Prune day dirs that became empty, then the month/year if empty.
      try {
        for (const d of readdirSync(mDir)) {
          const dDir = join(mDir, d);
          if (/^\d{2}$/.test(d) && readdirSync(dDir).length === 0) rmdirSync(dDir);
        }
        if (readdirSync(mDir).length === 0) rmdirSync(mDir);
      } catch {
        // best-effort pruning
      }
    }
    try {
      if (existsSync(yDir) && readdirSync(yDir).length === 0) rmdirSync(yDir);
    } catch {
      // best-effort
    }
  }
  return { removedIds };
}

/**
 * Admit a validated slice into the memory root: dedup by (source, session_id),
 * resolve same-minute collisions by stepping forward a minute at a time, then
 * write core.md + the monthly manifest entry ourselves. Never overwrites an
 * existing slice: identical re-submission is a 'duplicate' no-op, diverging
 * content for the same session is a hard IngestError.
 */
export function admitSlice(
  memoryRoot: string,
  slice: SubmittedSlice,
  timezone: string,
): AdmitResult {
  const existing = findIngestedSlice(memoryRoot, slice.source, slice.sessionId);
  if (existing !== null) {
    const existingPath = join(sliceDirFor(memoryRoot, existing.id), 'timeline', 'core.md');
    const existingBytes = existsSync(existingPath) ? readFileSync(existingPath, 'utf8') : null;
    const rendered = renderSubmittedSlice({ ...slice, sliceId: existing.id }, timezone);
    if (existingBytes === rendered) {
      return { action: 'duplicate', sliceId: existing.id, path: existingPath, remappedFrom: null };
    }
    throw new IngestError(
      [{
        path: 'frontmatter.session_id',
        message:
          `This (source, session_id) was already ingested as slice ${existing.id}, but the submitted ` +
          'content differs. Ingest never overwrites: reconcile on your side, or submit under a new session_id.',
      }],
      `session already ingested with different content (slice ${existing.id})`,
    );
  }

  // Same-minute collision with another session: step forward until free.
  let sliceId = slice.sliceId;
  let remappedFrom: string | null = null;
  for (let i = 0; i < 24 * 60; i++) {
    const corePath = join(sliceDirFor(memoryRoot, sliceId), 'timeline', 'core.md');
    if (!existsSync(corePath)) break;
    const head = readFileSync(corePath, 'utf8').slice(0, 4096);
    const owner = /^session_id:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^'(.*)'$/, '$1') ?? null;
    if (owner === slice.sessionId) break; // our own previous slot (resume corner)
    if (remappedFrom === null) remappedFrom = slice.sliceId;
    const parts = parseSliceId(sliceId);
    const date = new Date(
      Date.UTC(Number(parts!.y), Number(parts!.m) - 1, Number(parts!.d), Number(parts!.hm!.slice(0, 2)), Number(parts!.hm!.slice(2, 4)) + 1),
    );
    sliceId = sliceIdFromTimestamp(date.toISOString());
    if (i === 24 * 60 - 1) throw new IngestError([{ path: 'frontmatter.slice_id', message: `No free slice id near ${slice.sliceId}` }], 'slice id space exhausted');
  }

  const finalSlice = { ...slice, sliceId };
  const dir = join(sliceDirFor(memoryRoot, sliceId), 'timeline');
  const corePath = join(dir, 'core.md');
  const rendered = renderSubmittedSlice(finalSlice, timezone);
  if (!existsSync(corePath) || readFileSync(corePath, 'utf8') !== rendered) {
    writeFileAtomic(corePath, rendered);
  }

  const entry: ScribeIndexEntry = {
    id: sliceId,
    focus: slice.focus,
    summary: slice.summary,
    tags: slice.tags,
    status: 'closed',
    start: slice.start,
    open_loops: [],
    decisions: [],
    source: slice.source,
    sessionId: slice.sessionId,
  };
  upsertMonthlyIndex(memoryRoot, entry);

  return { action: 'written', sliceId, path: corePath, remappedFrom };
}
