import { createHash } from 'node:crypto';
import { existsSync, openSync, readFileSync, readSync, readdirSync, statSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { writeFileAtomic } from '../lib/atomic.js';
import { chainHash, CursorStore, EMPTY_HASH, type FileCursor } from './cursor.js';
import { CLAUDE_CODE_PARSER_VERSION, parseClaudeCodeLine } from './parsers/claude-code.js';
import { CODEX_PARSER_VERSION, parseCodexLine } from './parsers/codex.js';
import { GEMINI_PARSER_VERSION, parseGeminiDoc } from './parsers/gemini.js';
import {
  KIMI_CODE_PARSER_VERSION,
  kimiSessionIdFromPath,
  parseKimiCodeLine,
} from './parsers/kimi-code.js';
import { resolveSliceId, writeSessionSlice } from './slicer.js';
import {
  emptySourceStatus,
  recordError,
  writeScribeStatus,
  type ScribeStatus,
  type SourceStatus,
} from './status.js';
import {
  SCRIBE_SOURCES,
  type LineParser,
  type ScribeRoots,
  type ScribeSource,
  type SessionState,
} from './types.js';

/**
 * The scribe engine + watcher (design doc §5): incrementally transcribe other
 * agents' session logs into Previously time slices.
 *
 * Failure philosophy (§9): every per-file error is caught, recorded in the
 * status file, and surfaced — one bad file never kills the watcher loop.
 */

interface ParserEntry {
  parse: LineParser;
  version: number;
  /** True when the source rewrites a whole JSON document per save (Gemini):
   *  the file is re-read and re-derived from scratch on every change. */
  wholeFile?: boolean;
  /** Which files under the source root belong to this source. */
  matches: (filePath: string) => boolean;
  /** Derive a session id from the file path when the format has none in-band. */
  sessionIdFromPath?: (filePath: string) => string | undefined;
}

const isJsonl = (filePath: string): boolean => extname(filePath) === '.jsonl';

const PARSERS: Record<ScribeSource, ParserEntry> = {
  'claude-code': { parse: parseClaudeCodeLine, version: CLAUDE_CODE_PARSER_VERSION, matches: isJsonl },
  codex: { parse: parseCodexLine, version: CODEX_PARSER_VERSION, matches: isJsonl },
  'kimi-code': {
    parse: parseKimiCodeLine,
    version: KIMI_CODE_PARSER_VERSION,
    // Only the per-agent wire stream is conversational; nothing else under
    // the sessions tree is .jsonl today, but match precisely regardless.
    matches: (filePath) => basename(filePath) === 'wire.jsonl',
    sessionIdFromPath: kimiSessionIdFromPath,
  },
  gemini: {
    parse: parseGeminiDoc,
    version: GEMINI_PARSER_VERSION,
    wholeFile: true,
    matches: (filePath) =>
      extname(filePath) === '.json' && basename(dirname(filePath)) === 'chats',
  },
};

/** The per-source file matcher (which files under a root belong to it). */
export function sourceFileMatcher(source: ScribeSource): (filePath: string) => boolean {
  return PARSERS[source].matches;
}

/** Default watch roots under the user's home (Windows and macOS alike). */
export function resolveScribeRoots(homeDir: string = homedir()): ScribeRoots {
  return {
    'claude-code': join(homeDir, '.claude', 'projects'),
    codex: join(homeDir, '.codex', 'sessions'),
    'kimi-code': join(homeDir, '.kimi-code', 'sessions'),
    gemini: join(homeDir, '.gemini', 'tmp'),
  };
}

/** Recursively list files under root matching the source; [] when absent. */
export function listSessionFiles(root: string, matches: (filePath: string) => boolean): string[] {
  const rootStat = statSync(root, { throwIfNoEntry: false });
  if (rootStat === undefined || !rootStat.isDirectory()) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && matches(path)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface PersistedSessionState extends SessionState {
  /** Schema 2 = exchange-oriented event kinds (thinking/tool-call/tool-result). */
  _schema: 2;
  filePath: string;
}

export interface ScribeEngineOptions {
  memoryRoot: string;
  /** Per-session accumulated state lives here (PREVIOUSLY_HOME-aware). */
  sessionsDir: string;
  cursorStore: CursorStore;
  statusPath: string;
  roots: ScribeRoots;
  /** Defaults to the system zone; injectable for deterministic tests. */
  timezone?: string;
}

export interface FileProcessResult {
  filePath: string;
  source: ScribeSource;
  /** True when the file shrank below the cursor and was re-read from 0. */
  truncated: boolean;
  newEvents: number;
  newParseErrors: number;
  sliceId: string | null;
}

export interface ScanSummary {
  sources: Record<ScribeSource, SourceStatus>;
  errors: { file: string; message: string }[];
}

export class ScribeEngine {
  private readonly memoryRoot: string;
  private readonly sessionsDir: string;
  private readonly cursors: CursorStore;
  private readonly statusPath: string;
  private readonly roots: ScribeRoots;
  private readonly timezone: string;
  private readonly status: ScribeStatus;
  /** Serializes processing per file so rapid watch events never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: ScribeEngineOptions) {
    this.memoryRoot = opts.memoryRoot;
    this.sessionsDir = opts.sessionsDir;
    this.cursors = opts.cursorStore;
    this.statusPath = opts.statusPath;
    this.roots = opts.roots;
    this.timezone =
      opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    this.status = {
      _schema: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sources: Object.fromEntries(
        SCRIBE_SOURCES.map((source) => [
          source,
          emptySourceStatus(opts.roots[source], existsSync(opts.roots[source])),
        ]),
      ) as Record<ScribeSource, SourceStatus>,
      errors: [],
    };
  }

  private defaultSessionId(filePath: string, source: ScribeSource): string {
    const fromPath = PARSERS[source].sessionIdFromPath?.(filePath);
    if (fromPath !== undefined) return fromPath;
    return sanitizeFilePart(basename(filePath, extname(filePath)));
  }

  private sessionStatePath(filePath: string, source: ScribeSource): string {
    const key = createHash('sha256').update(filePath).digest('hex').slice(0, 12);
    const name = sanitizeFilePart(basename(filePath, extname(filePath)));
    return join(this.sessionsDir, source, `${name}-${key}.json`);
  }

  private loadSessionState(filePath: string, source: ScribeSource): SessionState | null {
    const path = this.sessionStatePath(filePath, source);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedSessionState;
    if (parsed._schema !== 2 || parsed.filePath !== filePath) return null;
    return {
      source: parsed.source,
      sessionId: parsed.sessionId,
      sliceId: parsed.sliceId,
      events: parsed.events,
      appendix: parsed.appendix,
      parseErrors: parsed.parseErrors,
    };
  }

  private saveSessionState(filePath: string, state: SessionState): void {
    const persisted: PersistedSessionState = { _schema: 2, filePath, ...state };
    writeFileAtomic(
      this.sessionStatePath(filePath, state.source),
      JSON.stringify(persisted) + '\n',
    );
  }

  /** Read the unprocessed tail of a file. Returns the complete-line prefix of
   *  the tail and the byte offset just past it (a trailing partial line is
   *  left for the next pass). */
  private static readTail(
    filePath: string,
    offset: number,
    size: number,
  ): { chunk: Buffer; newOffset: number } {
    if (size <= offset) return { chunk: Buffer.alloc(0), newOffset: offset };
    const fd = openSync(filePath, 'r');
    try {
      const raw = Buffer.alloc(size - offset);
      const read = readSync(fd, raw, 0, raw.length, offset);
      const lastNewline = raw.subarray(0, read).lastIndexOf(0x0a);
      if (lastNewline === -1) return { chunk: Buffer.alloc(0), newOffset: offset };
      const end = lastNewline + 1;
      return { chunk: raw.subarray(0, end), newOffset: offset + end };
    } finally {
      closeSync(fd);
    }
  }

  private sourceStatus(source: ScribeSource): SourceStatus {
    return this.status.sources[source];
  }

  /** Update the filesSeen count for a source by walking its root. */
  refreshFilesSeen(source: ScribeSource): void {
    const root = this.roots[source];
    const present = existsSync(root);
    const status = this.sourceStatus(source);
    status.rootPresent = present;
    status.filesSeen = present ? listSessionFiles(root, PARSERS[source].matches).length : 0;
    status.filesProcessed = this.cursors.files().filter((f) => this.cursors.get(f)?.source === source).length;
  }

  /**
   * Process one session log file from its cursor position. The pipeline:
   * truncation/rotation detection → read tail → parse lines (format tax:
   * failures go to the session appendix, counted) → grow the accumulated
   * session state → rewrite the slice (deterministic, idempotent) → advance
   * the cursor. Any error is recorded in status and re-thrown to the caller's
   * per-file isolation boundary.
   */
  async processFile(filePath: string, source: ScribeSource): Promise<FileProcessResult | null> {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    // A vanished file (Gemini retention cleanup, USB-drive home ejected, …) is
    // routine, not an error: nothing to do, the unlink path owns the cursor.
    if (stat === undefined || !stat.isFile()) return null;

    const parser = PARSERS[source];
    if (parser.wholeFile === true) return this.processWholeFile(filePath, source, stat.size);

    let cursor = this.cursors.get(filePath);
    let truncated = false;
    let state: SessionState | null = null;

    if (
      cursor !== null &&
      (stat.size < cursor.offset || cursor.parserVersion !== parser.version || cursor.source !== source)
    ) {
      // Truncated/rotated, or the parser changed: start over from byte 0 with
      // a fresh session state. Deterministic rewrite keeps this idempotent.
      truncated = true;
      cursor = null;
    }
    if (cursor !== null) {
      state = this.loadSessionState(filePath, source);
      if (state === null) cursor = null; // state lost → rebuild from 0
    }

    const offset = cursor?.offset ?? 0;
    const { chunk, newOffset } = ScribeEngine.readTail(filePath, offset, stat.size);

    if (state === null) {
      state = {
        source,
        sessionId: this.defaultSessionId(filePath, source),
        sliceId: null,
        events: [],
        appendix: [],
        parseErrors: 0,
      };
    }

    let newEvents = 0;
    let newParseErrors = 0;
    if (chunk.length > 0) {
      const lines = chunk.toString('utf8').split('\n');
      let lineCount = cursor?.lines ?? 0;
      let hash = cursor?.hash ?? EMPTY_HASH;
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        lineCount += 1;
        const outcome = parser.parse(line);
        if (outcome.sessionId !== undefined && state.events.length === 0 && state.sliceId === null) {
          state.sessionId = outcome.sessionId;
        }
        if (outcome.appendix.length > 0) {
          state.appendix.push(...outcome.appendix);
          state.parseErrors += outcome.appendix.length;
          newParseErrors += outcome.appendix.length;
        }
        if (outcome.events.length > 0) {
          if (state.sliceId === null) {
            state.sliceId = resolveSliceId(this.memoryRoot, state.sessionId, outcome.events[0]!.timestamp);
          }
          state.events.push(...outcome.events);
          newEvents += outcome.events.length;
        }
      }
      hash = chainHash(hash, chunk);
      const newCursor: FileCursor = {
        source,
        offset: newOffset,
        lines: lineCount,
        hash,
        parserVersion: parser.version,
        updatedAt: new Date().toISOString(),
      };
      this.cursors.set(filePath, newCursor);
      this.cursors.save();
    } else if (cursor === null) {
      // Empty (or not-yet-complete) first sighting: still record a cursor so
      // filesProcessed reflects that we saw it.
      this.cursors.set(filePath, {
        source,
        offset: 0,
        lines: 0,
        hash: EMPTY_HASH,
        parserVersion: parser.version,
        updatedAt: new Date().toISOString(),
      });
      this.cursors.save();
    }

    if (newEvents > 0 || newParseErrors > 0 || cursor === null || truncated) {
      this.saveSessionState(filePath, state);
    }
    if (state.sliceId !== null && newEvents + newParseErrors > 0) {
      writeSessionSlice(this.memoryRoot, state, this.timezone);
    }

    const status = this.sourceStatus(source);
    status.events += newEvents;
    status.parseErrors += newParseErrors;
    if (newEvents > 0) {
      const last = state.events[state.events.length - 1]!.timestamp;
      if (status.lastEventAt === null || last > status.lastEventAt) status.lastEventAt = last;
    }
    status.filesProcessed = this.cursors.files().filter((f) => this.cursors.get(f)?.source === source).length;
    this.writeStatus();

    return { filePath, source, truncated, newEvents, newParseErrors, sliceId: state.sliceId };
  }

  /**
   * Whole-document sources (Gemini chat checkpoints): the file is rewritten
   * wholesale on every save, so there is no byte-offset tail to chase. The
   * content-hash cursor decides whether anything changed; a change re-derives
   * the full session state from scratch (the slice id is kept from the
   * previous state so rewrites stay in place). Deterministic rendering keeps
   * re-derives byte-identical, so this is idempotent.
   */
  private processWholeFile(
    filePath: string,
    source: ScribeSource,
    size: number,
  ): FileProcessResult {
    const parser = PARSERS[source];
    const raw = readFileSync(filePath);
    const hash = chainHash(EMPTY_HASH, raw);
    const cursor = this.cursors.get(filePath);

    if (
      cursor !== null &&
      cursor.hash === hash &&
      cursor.parserVersion === parser.version &&
      cursor.source === source
    ) {
      // Unchanged since the last pass — nothing to do.
      const prior = this.loadSessionState(filePath, source);
      return { filePath, source, truncated: false, newEvents: 0, newParseErrors: 0, sliceId: prior?.sliceId ?? null };
    }

    const prevState = cursor !== null ? this.loadSessionState(filePath, source) : null;
    const outcome = parser.parse(raw.toString('utf8'));
    const state: SessionState = {
      source,
      sessionId:
        outcome.sessionId ?? prevState?.sessionId ?? this.defaultSessionId(filePath, source),
      sliceId: prevState?.sliceId ?? null,
      events: outcome.events,
      appendix: outcome.appendix,
      parseErrors: outcome.appendix.length,
    };
    if (state.sliceId === null && outcome.events.length > 0) {
      state.sliceId = resolveSliceId(this.memoryRoot, state.sessionId, outcome.events[0]!.timestamp);
    }

    // Status counters are cumulative; for a re-derived document only the
    // growth since the last pass is "new".
    const newEvents = Math.max(0, outcome.events.length - (prevState?.events.length ?? 0));
    const newParseErrors = Math.max(0, outcome.appendix.length - (prevState?.parseErrors ?? 0));

    this.cursors.set(filePath, {
      source,
      offset: size,
      lines: 1,
      hash,
      parserVersion: parser.version,
      updatedAt: new Date().toISOString(),
    });
    this.cursors.save();
    this.saveSessionState(filePath, state);
    if (state.sliceId !== null) writeSessionSlice(this.memoryRoot, state, this.timezone);

    const status = this.sourceStatus(source);
    status.events += newEvents;
    status.parseErrors += newParseErrors;
    if (outcome.events.length > 0) {
      const last = outcome.events[outcome.events.length - 1]!.timestamp;
      if (status.lastEventAt === null || last > status.lastEventAt) status.lastEventAt = last;
    }
    status.filesProcessed = this.cursors.files().filter((f) => this.cursors.get(f)?.source === source).length;
    this.writeStatus();

    return { filePath, source, truncated: false, newEvents, newParseErrors, sliceId: state.sliceId };
  }

  /** Serialized per-file entry point used by the watcher callbacks. */
  enqueue(filePath: string, source: ScribeSource): void {
    const prev = this.queues.get(filePath) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.processFile(filePath, source);
        } catch (err) {
          recordError(this.status, filePath, err);
          this.writeStatus();
        }
      });
    this.queues.set(filePath, next);
  }

  /** Wait until every queued file has been processed (shutdown/tests). */
  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()].map((p) => p.catch(() => undefined)));
  }

  handleUnlink(filePath: string): void {
    this.cursors.remove(filePath);
    this.cursors.save();
  }

  /** Load persisted cursors (called once before any processing). */
  loadCursors(): void {
    const note = this.cursors.load();
    if (note !== null) {
      recordError(this.status, this.cursors.path, new Error(note));
      this.writeStatus();
    }
  }

  /** One-shot full scan (backfill / debugging / `previously scribe once`). */
  async scanOnce(sourceFilter?: ScribeSource): Promise<ScanSummary> {
    this.loadCursors();
    const errors: { file: string; message: string }[] = [];
    for (const source of SCRIBE_SOURCES) {
      if (sourceFilter !== undefined && source !== sourceFilter) continue;
      try {
        this.refreshFilesSeen(source);
        for (const file of listSessionFiles(this.roots[source], PARSERS[source].matches)) {
          try {
            await this.processFile(file, source);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ file, message });
            recordError(this.status, file, err);
          }
        }
      } catch (err) {
        // Root-level failure (e.g. unreadable directory): isolated per source.
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ file: this.roots[source], message });
        recordError(this.status, this.roots[source], err);
      }
    }
    this.writeStatus();
    return { sources: this.status.sources, errors };
  }

  writeStatus(): void {
    writeScribeStatus(this.statusPath, this.status);
  }

  getStatus(): ScribeStatus {
    return this.status;
  }
}

/**
 * Chokidar-based fs watch over the per-agent session log roots. Missing roots
 * are reported absent in status and simply not watched (never a crash);
 * `rescan()` picks up roots that appear later.
 */
export class ScribeWatcher {
  private watcher: FSWatcher | null = null;
  private readonly watchedRoots = new Set<string>();

  constructor(
    private readonly engine: ScribeEngine,
    private readonly roots: ScribeRoots,
  ) {}

  private sourceFor(filePath: string): ScribeSource | null {
    for (const source of SCRIBE_SOURCES) {
      const rel = relative(this.roots[source], filePath);
      if (rel !== '' && !rel.startsWith('..') && !rel.includes(':')) return source;
    }
    return null;
  }

  async start(): Promise<void> {
    this.engine.loadCursors();
    await this.ensureWatcher();
    for (const source of SCRIBE_SOURCES) this.engine.refreshFilesSeen(source);
    this.engine.writeStatus();
  }

  /**
   * Create the chokidar watcher lazily and attach newly-appeared roots.
   * Chokidar never fires `ready` for an empty path list, so with all roots
   * absent we simply stay watcher-less until a rescan finds one — the missing
   * roots are reported in status either way. Roots that vanished (USB-drive
   * home ejected, cleanup) are pruned so a later reappearance is re-attached.
   */
  private async ensureWatcher(): Promise<void> {
    for (const root of [...this.watchedRoots]) {
      if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) {
        this.watchedRoots.delete(root);
        await this.watcher?.unwatch(root);
      }
    }
    const newRoots = SCRIBE_SOURCES.map((s) => this.roots[s]).filter((root) => {
      const stat = statSync(root, { throwIfNoEntry: false });
      return stat?.isDirectory() === true && !this.watchedRoots.has(root);
    });
    if (newRoots.length === 0) return;

    if (this.watcher === null) {
      this.watcher = watch(newRoots, {
        ignoreInitial: false,
        persistent: true,
        // Session logs are appended in bursts; let writes settle before reading.
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });
      this.watcher.on('add', (path) => this.onFile(path));
      this.watcher.on('change', (path) => this.onFile(path));
      this.watcher.on('unlink', (path) => this.engine.handleUnlink(path));
      this.watcher.on('error', (err) => {
        recordError(this.engine.getStatus(), '(watcher)', err);
        this.engine.writeStatus();
      });
      // An error before `ready` (e.g. a root ejected mid-attach) must not hang
      // start() forever — the error is already recorded in status; move on.
      await new Promise<void>((resolve) => {
        this.watcher!.on('ready', () => resolve());
        this.watcher!.once('error', () => resolve());
      });
    } else {
      this.watcher.add(newRoots);
    }
    for (const root of newRoots) this.watchedRoots.add(root);
  }

  private onFile(path: string): void {
    const source = this.sourceFor(path);
    if (source === null) return;
    if (!PARSERS[source].matches(path)) return;
    this.engine.enqueue(path, source);
  }

  /** Pick up roots that appeared after start; re-walk everything (cheap:
   *  cursors make already-processed files no-ops). */
  async rescan(): Promise<void> {
    await this.ensureWatcher();
    for (const source of SCRIBE_SOURCES) {
      const root = this.roots[source];
      this.engine.refreshFilesSeen(source);
      for (const file of listSessionFiles(root, PARSERS[source].matches)) {
        this.engine.enqueue(file, source);
      }
    }
    await this.engine.drain();
    this.engine.writeStatus();
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    await this.engine.drain();
    this.engine.writeStatus();
  }
}
