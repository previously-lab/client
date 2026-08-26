import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertInside, parseSliceId, sliceIdToRelDir } from './slices.js';

/**
 * Read-only access to the episodic memory directory (design doc §6).
 *
 * Failure philosophy (§9): every failure surfaces as a structured, honest
 * MemoryError — missing files, malformed ids, absent strands are reported,
 * never papered over with fabricated content.
 */

export type MemoryErrorCode = 'not_found' | 'invalid_id' | 'invalid_args' | 'invalid_data';

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

export interface TimelineFilter {
  /** `YYYY-MM` — keep only that month's section. */
  month?: string;
  /** `MM-DD` — keep only that day within the (filtered) month. */
  day?: string;
  /** `YYYY-MM-DD` — inclusive lower bound on day sections (date-window mode). */
  from?: string;
  /** `YYYY-MM-DD` — inclusive upper bound on day sections (date-window mode). */
  to?: string;
}

export interface LineRange {
  /** 1-based, inclusive. */
  startLine?: number;
  /** 1-based, inclusive. */
  endLine?: number;
}

export interface SearchMatch {
  /** Path relative to the memory root, forward slashes. */
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  matchCount: number;
  truncated: boolean;
  matches: SearchMatch[];
}

const MAX_SEARCH_MATCHES = 50;
const MAX_MATCH_LINE = 300;

function episodicDir(memoryRoot: string): string {
  return join(memoryRoot, 'episodic');
}

/**
 * Read the human timeline. Prefers `episodic/timeline.md`; falls back to the
 * machine index `episodic/timeline/index.json` when only that exists.
 * The optional month/day filter narrows timeline.md to the matching
 * `## YYYY-MM` / `### MM-DD` sections; the optional from/to date window
 * (mutually exclusive with month/day) keeps the day sections whose full date
 * falls inside the inclusive range. Neither filter applies to the JSON index.
 */
export function readTimeline(memoryRoot: string, filter: TimelineFilter = {}): string {
  // Shape AND range — a 13th month / 45th day is a usage error, not a miss.
  if (filter.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) {
    throw new MemoryError('invalid_args', `month must be YYYY-MM (month 01-12), got: ${filter.month}`);
  }
  if (filter.day !== undefined && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(filter.day)) {
    throw new MemoryError('invalid_args', `day must be MM-DD (month 01-12, day 01-31), got: ${filter.day}`);
  }
  const dateRe = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  if (filter.from !== undefined && !dateRe.test(filter.from)) {
    throw new MemoryError('invalid_args', `from must be YYYY-MM-DD (a real month/day), got: ${filter.from}`);
  }
  if (filter.to !== undefined && !dateRe.test(filter.to)) {
    throw new MemoryError('invalid_args', `to must be YYYY-MM-DD (a real month/day), got: ${filter.to}`);
  }
  if (
    (filter.from !== undefined || filter.to !== undefined) &&
    (filter.month !== undefined || filter.day !== undefined)
  ) {
    throw new MemoryError('invalid_args', '--from/--to cannot be combined with --month/--day');
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    throw new MemoryError('invalid_args', `from must be <= to, got: ${filter.from}..${filter.to}`);
  }

  const mdPath = join(episodicDir(memoryRoot), 'timeline.md');
  if (existsSync(mdPath)) {
    const content = readFileSync(assertInside(memoryRoot, mdPath), 'utf8');
    return filter.from !== undefined || filter.to !== undefined
      ? filterTimelineByDate(content, filter)
      : filterTimeline(content, filter);
  }

  const indexPath = join(episodicDir(memoryRoot), 'timeline', 'index.json');
  if (existsSync(indexPath)) {
    return readFileSync(assertInside(memoryRoot, indexPath), 'utf8');
  }

  throw new MemoryError(
    'not_found',
    `No timeline found under ${episodicDir(memoryRoot)} (looked for timeline.md and timeline/index.json). ` +
      'The memory directory may be empty or not initialized yet.',
  );
}

/** Narrow timeline.md text to the requested month/day sections. */
function filterTimeline(content: string, filter: TimelineFilter): string {
  if (filter.month === undefined && filter.day === undefined) return content;
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inMonth = filter.month === undefined;
  let inDay = filter.day === undefined;
  let sawEntry = false;
  for (const line of lines) {
    const monthMatch = /^## (\d{4}-\d{2})\b/.exec(line);
    if (monthMatch) {
      inMonth = filter.month === undefined || monthMatch[1] === filter.month;
      inDay = inMonth && filter.day === undefined;
      if (inMonth && filter.day === undefined) out.push(line);
      continue;
    }
    const dayMatch = /^### (\d{2}-\d{2})\b/.exec(line);
    if (dayMatch) {
      inDay = inMonth && (filter.day === undefined || dayMatch[1] === filter.day);
      if (inDay) out.push(line);
      continue;
    }
    if (line.startsWith('# ')) {
      // Top-level title — keep it for context.
      out.push(line);
      continue;
    }
    if (inMonth && inDay) {
      // Entry lines (`- **slice-id** …`) are the content; headings alone mean
      // the filter matched nothing.
      if (line.startsWith('- ')) sawEntry = true;
      out.push(line);
    }
  }
  const result = out.join('\n').trim();
  if (result === '' || !sawEntry) {
    const scope = [filter.month, filter.day].filter(Boolean).join(' / ');
    throw new MemoryError('not_found', `No timeline entries match filter: ${scope}`);
  }
  return result + '\n';
}

/**
 * Narrow timeline.md text to the day sections whose full date (month heading
 * + day heading) falls inside the inclusive [from, to] window. Month headings
 * are kept only when they contain a matching day; the `# ` title is kept.
 */
function filterTimelineByDate(content: string, filter: TimelineFilter): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let month = '';
  let monthKept = false;
  let inDay = false;
  let sawEntry = false;
  for (const line of lines) {
    const monthMatch = /^## (\d{4}-\d{2})\b/.exec(line);
    if (monthMatch) {
      month = monthMatch[1]!;
      monthKept = false;
      inDay = false;
      continue;
    }
    const dayMatch = /^### (\d{2}-\d{2})\b/.exec(line);
    if (dayMatch) {
      // Day headings are MM-DD; the year comes from the month heading.
      const date = `${month.slice(0, 4)}-${dayMatch[1]}`;
      inDay =
        month !== '' &&
        (filter.from === undefined || date >= filter.from) &&
        (filter.to === undefined || date <= filter.to);
      if (inDay) {
        if (!monthKept) {
          out.push(`## ${month}`);
          monthKept = true;
        }
        out.push(line);
      }
      continue;
    }
    if (line.startsWith('# ')) {
      // Top-level title — keep it for context.
      out.push(line);
      continue;
    }
    if (inDay) {
      // Entry lines (`- **slice-id** …`) are the content; headings alone mean
      // the filter matched nothing.
      if (line.startsWith('- ')) sawEntry = true;
      out.push(line);
    }
  }
  const result = out.join('\n').trim();
  if (result === '' || !sawEntry) {
    const scope = `${filter.from ?? '…'}..${filter.to ?? '…'}`;
    throw new MemoryError('not_found', `No timeline entries match date window: ${scope}`);
  }
  return result + '\n';
}

/** Resolve + read a file belonging to a slice (id strictly validated). */
function readSliceFile(memoryRoot: string, sliceId: string, relFile: string, label: string): string {
  const parts = parseSliceId(sliceId);
  if (parts === null) {
    throw new MemoryError(
      'invalid_id',
      `Invalid slice id: ${JSON.stringify(sliceId)} — expected YYYY-MM-DD-HHMM`,
    );
  }
  const filePath = join(
    episodicDir(memoryRoot),
    'slices',
    ...sliceIdToRelDir(parts).split('/'),
    ...relFile.split('/'),
  );
  if (!existsSync(filePath)) {
    throw new MemoryError('not_found', `No ${label} found for slice ${sliceId} (missing ${filePath})`);
  }
  return readFileSync(assertInside(memoryRoot, filePath), 'utf8');
}

/** Narrow content to a 1-based inclusive line range. */
function applyLineRange(content: string, range: LineRange): string {
  if (range.startLine === undefined && range.endLine === undefined) return content;
  const lines = content.split(/\r?\n/);
  const start = range.startLine ?? 1;
  const end = range.endLine ?? lines.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new MemoryError(
      'invalid_args',
      `Invalid line range ${range.startLine ?? ''}..${range.endLine ?? ''} (1-based, inclusive, start <= end)`,
    );
  }
  return lines.slice(start - 1, end).join('\n') + '\n';
}

/**
 * Read a slice's conversation record (`timeline/core.md`). Optional 1-based
 * inclusive line range. Legacy date-only slice ids resolve to the day
 * directory's core.md, mirroring the agent repo's sliceIdToFilePath.
 */
export function readSlice(memoryRoot: string, sliceId: string, range: LineRange = {}): string {
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/core.md', 'slice');
  return applyLineRange(content, range);
}

/** The last N lines of a slice's conversation record (trailing newline excluded from the count). */
export function readSliceTail(memoryRoot: string, sliceId: string, lastLines: number): string {
  if (!Number.isInteger(lastLines) || lastLines < 1) {
    throw new MemoryError('invalid_args', `last must be a positive integer, got: ${lastLines}`);
  }
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/core.md', 'slice');
  const lines = content.split(/\r?\n/);
  const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  return body.slice(-lastLines).join('\n') + '\n';
}

/** Default context lines above/below each --search hit. */
export const SLICE_SEARCH_CONTEXT = 2;

/**
 * Substring search (case-insensitive) within ONE slice's conversation record.
 * Returns the matching lines plus SLICE_SEARCH_CONTEXT lines of context, each
 * line prefixed with its 1-based line number so a follow-up read can use
 * --start/--end; disjoint ranges are separated by a `…` line. A no-match
 * search is a success with an explicit "no matches" line, never a fabrication.
 */
export function searchSlice(memoryRoot: string, sliceId: string, text: string): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new MemoryError('invalid_args', 'search text must be a non-empty string');
  }
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/core.md', 'slice');
  const lines = content.split(/\r?\n/);
  const needle = text.toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(needle)) hits.push(i);
  }
  if (hits.length === 0) {
    return `No lines matching ${JSON.stringify(text)} in slice ${sliceId}.\n`;
  }
  const out: string[] = [];
  let coveredUntil = -1;
  for (const hit of hits) {
    const from = Math.max(0, hit - SLICE_SEARCH_CONTEXT);
    const to = Math.min(lines.length - 1, hit + SLICE_SEARCH_CONTEXT);
    if (from > coveredUntil + 1 && coveredUntil >= 0) out.push('…');
    for (let i = Math.max(from, coveredUntil + 1); i <= to; i++) {
      out.push(`${i + 1}: ${lines[i]}`);
    }
    coveredUntil = Math.max(coveredUntil, to);
  }
  return out.join('\n') + '\n';
}

/** Turn heading written by the slicer: `## Turn <id> — <ISO timestamp> (user|agent)`. */
const TURN_HEADER = /^## Turn [A-Za-z0-9_-]{1,16} — /;

/**
 * Read a 1-based inclusive range of turns from a slice's conversation record,
 * delimited by the `## Turn …` headings (frontmatter excluded). A slice
 * without machine-readable turn headings is reported honestly.
 */
export function readSliceTurns(
  memoryRoot: string,
  sliceId: string,
  fromTurn: number,
  toTurn: number,
): string {
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/core.md', 'slice');
  const lines = content.split(/\r?\n/);
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TURN_HEADER.test(lines[i] ?? '')) headers.push(i);
  }
  if (headers.length === 0) {
    throw new MemoryError(
      'invalid_data',
      `Slice ${sliceId} has no machine-readable turn structure (## Turn … headings) in timeline/core.md`,
    );
  }
  if (!Number.isInteger(fromTurn) || !Number.isInteger(toTurn) || fromTurn < 1 || toTurn < fromTurn || toTurn > headers.length) {
    throw new MemoryError(
      'invalid_args',
      `Invalid turn range ${fromTurn}-${toTurn} (slice ${sliceId} has ${headers.length} turn(s), 1-based inclusive)`,
    );
  }
  const start = headers[fromTurn - 1]!;
  const end = toTurn < headers.length ? headers[toTurn]! : lines.length;
  return lines.slice(start, end).join('\n') + '\n';
}

/**
 * Read ONLY the YAML frontmatter of a slice's conversation record
 * (`timeline/core.md`): focus/summary/tags/tone/turns etc. The conversation
 * body is never returned — open it with readSlice when needed.
 */
export function readSliceSummary(memoryRoot: string, sliceId: string): string {
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/core.md', 'slice');
  // Tolerate a UTF-8 BOM — a BOM'd file still HAS frontmatter.
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new MemoryError(
      'invalid_data',
      `Slice ${sliceId} has no YAML frontmatter in timeline/core.md (expected a leading --- block)`,
    );
  }
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    throw new MemoryError(
      'invalid_data',
      `Slice ${sliceId} has an unterminated YAML frontmatter block in timeline/core.md`,
    );
  }
  return lines.slice(0, end + 1).join('\n') + '\n';
}

/**
 * Read a slice's cognition record (`timeline/agent.md`). Optional 1-based
 * inclusive line range, same contract as readSlice.
 */
export function readAgentTimeline(memoryRoot: string, sliceId: string, range: LineRange = {}): string {
  const content = readSliceFile(memoryRoot, sliceId, 'timeline/agent.md', 'agent timeline');
  return applyLineRange(content, range);
}

/**
 * Read the Previously card. Without a slice id: the live card
 * (`episodic/current-previously.md`). With a slice id: that slice's card
 * snapshot (`previously.md` next to the slice's timeline dir).
 */
export function readCard(memoryRoot: string, sliceId?: string): string {
  if (sliceId === undefined) {
    const cardPath = join(episodicDir(memoryRoot), 'current-previously.md');
    if (!existsSync(cardPath)) {
      throw new MemoryError(
        'not_found',
        `No live card found (missing ${cardPath}). The memory directory may be empty or not initialized yet.`,
      );
    }
    return readFileSync(assertInside(memoryRoot, cardPath), 'utf8');
  }
  return readSliceFile(memoryRoot, sliceId, 'previously.md', 'card snapshot');
}

/** Raw strands map: strand name → slice rel-paths (`YYYY/MM/DD/HHMM`). */
function loadStrands(memoryRoot: string): Record<string, string[]> {
  const strandsPath = join(episodicDir(memoryRoot), 'strands.json');
  if (!existsSync(strandsPath)) {
    throw new MemoryError('not_found', `No strands.json under ${episodicDir(memoryRoot)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(assertInside(memoryRoot, strandsPath), 'utf8'));
  } catch {
    throw new MemoryError('invalid_data', `strands.json is not valid JSON: ${strandsPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryError('invalid_data', `strands.json has unexpected shape (expected object): ${strandsPath}`);
  }
  return parsed as Record<string, string[]>;
}

export function listStrands(memoryRoot: string): Array<{ name: string; sliceCount: number }> {
  const strands = loadStrands(memoryRoot);
  return Object.entries(strands)
    .map(([name, slices]) => ({ name, sliceCount: Array.isArray(slices) ? slices.length : 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readStrand(memoryRoot: string, name: string): { name: string; slices: string[] } {
  const strands = loadStrands(memoryRoot);
  // Object.hasOwn — a JSON.parse'd map still exposes prototype keys
  // ("constructor", …) via bracket access; those are NOT strands.
  if (!Object.hasOwn(strands, name)) {
    const available = Object.keys(strands).sort();
    throw new MemoryError(
      'not_found',
      `No strand named ${JSON.stringify(name)}. Available strands: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }
  const slices = strands[name];
  return { name, slices: Array.isArray(slices) ? slices : [] };
}

/**
 * Substring search (case-insensitive) across slice conversation records and
 * monthly `_index.json` manifests. No embeddings, no ranking — matches are
 * returned in path order, capped at MAX_SEARCH_MATCHES.
 */
export function searchMemory(memoryRoot: string, query: string): SearchResult {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new MemoryError('invalid_args', 'query must be a non-empty string');
  }
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let truncated = false;

  const slicesRoot = join(episodicDir(memoryRoot), 'slices');
  if (!existsSync(slicesRoot)) {
    throw new MemoryError('not_found', `No slices directory under ${episodicDir(memoryRoot)}`);
  }

  for (const file of walkSearchableFiles(slicesRoot)) {
    if (truncated) break;
    const rel = file.slice(slicesRoot.length + 1).split('\\').join('/');
    const path = `episodic/slices/${rel}`;
    let content: string;
    try {
      content = readFileSync(assertInside(memoryRoot, file), 'utf8');
    } catch {
      continue; // Unreadable file — skip, don't fabricate.
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line.toLowerCase().includes(needle)) continue;
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      matches.push({
        path,
        line: i + 1,
        text: line.length > MAX_MATCH_LINE ? line.slice(0, MAX_MATCH_LINE) + '…' : line,
      });
    }
  }

  return { query, matchCount: matches.length, truncated, matches };
}

/** All core.md conversation records plus monthly _index.json manifests. */
function* walkSearchableFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      yield* walkSearchableFiles(full);
    } else if (entry === 'core.md' || entry === '_index.json') {
      yield full;
    }
  }
}
