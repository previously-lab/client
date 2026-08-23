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
 * `## YYYY-MM` / `### MM-DD` sections (it does not apply to the JSON index).
 */
export function readTimeline(memoryRoot: string, filter: TimelineFilter = {}): string {
  // Shape AND range — a 13th month / 45th day is a usage error, not a miss.
  if (filter.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) {
    throw new MemoryError('invalid_args', `month must be YYYY-MM (month 01-12), got: ${filter.month}`);
  }
  if (filter.day !== undefined && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(filter.day)) {
    throw new MemoryError('invalid_args', `day must be MM-DD (month 01-12, day 01-31), got: ${filter.day}`);
  }

  const mdPath = join(episodicDir(memoryRoot), 'timeline.md');
  if (existsSync(mdPath)) {
    const content = readFileSync(assertInside(memoryRoot, mdPath), 'utf8');
    return filterTimeline(content, filter);
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
