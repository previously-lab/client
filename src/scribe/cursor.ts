import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeFileAtomic } from '../lib/atomic.js';
import type { ScribeSource } from './types.js';

/**
 * Incremental cursor per watched file (design doc §4): byte offset + line
 * count + a chained content hash of everything processed so far, persisted to
 * `<PREVIOUSLY_HOME>/scribe/cursors.json` with atomic writes. Restart-safe:
 * on startup the scribe resumes exactly where the cursor points; a file that
 * shrank below the cursor offset is treated as truncated/rotated and re-read
 * from byte 0.
 */
export interface FileCursor {
  source: ScribeSource;
  /** Byte offset of the first unprocessed byte (past the last full line). */
  offset: number;
  /** Number of complete lines processed so far. */
  lines: number;
  /** Chained sha256 over all processed chunks — detects change, enables dedup. */
  hash: string;
  /** Parser version that produced this cursor; mismatch forces a re-read. */
  parserVersion: number;
  updatedAt: string;
}

interface CursorFile {
  _schema: 1;
  files: Record<string, FileCursor>;
}

/** Chain one processed chunk into the running content hash. */
export function chainHash(previousHash: string, chunk: Buffer): string {
  return createHash('sha256').update(previousHash, 'utf8').update(chunk).digest('hex');
}

export const EMPTY_HASH = createHash('sha256').digest('hex');

export class CursorStore {
  private data: CursorFile = { _schema: 1, files: {} };

  constructor(readonly path: string) {}

  /**
   * Load cursors from disk. A corrupt file is quarantined next to the
   * original (never silently discarded, per the failure philosophy) and the
   * store starts empty; the caller surfaces the quarantine in status.
   */
  load(): string | null {
    if (!existsSync(this.path)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as CursorFile;
      if (raw._schema !== 1 || typeof raw.files !== 'object' || raw.files === null) {
        throw new Error('unrecognized shape');
      }
      this.data = raw;
      return null;
    } catch (err) {
      const quarantine = `${this.path}.corrupt`;
      renameSync(this.path, quarantine);
      this.data = { _schema: 1, files: {} };
      return `cursors.json was unreadable (${err instanceof Error ? err.message : err}); quarantined to ${quarantine}`;
    }
  }

  get(filePath: string): FileCursor | null {
    return this.data.files[filePath] ?? null;
  }

  set(filePath: string, cursor: FileCursor): void {
    this.data.files[filePath] = cursor;
  }

  remove(filePath: string): void {
    delete this.data.files[filePath];
  }

  /** All tracked file paths (for status reporting / pruning). */
  files(): string[] {
    return Object.keys(this.data.files);
  }

  save(): void {
    writeFileAtomic(this.path, JSON.stringify(this.data, null, 2) + '\n');
  }
}
