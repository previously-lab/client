import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../lib/atomic.js';
import type { ScribeSource } from './types.js';

/**
 * Cross-process scribe status (`<PREVIOUSLY_HOME>/scribe/status.json`).
 * The watcher process rewrites it after every processed file; `previously
 * status` reads it. Written atomically so readers never see a partial file.
 */
export interface SourceStatus {
  root: string;
  rootPresent: boolean;
  filesSeen: number;
  filesProcessed: number;
  events: number;
  parseErrors: number;
  /** ISO timestamp of the most recent transcribed event, if any. */
  lastEventAt: string | null;
}

export interface ScribeError {
  file: string;
  message: string;
  at: string;
}

export interface ScribeStatus {
  _schema: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  sources: Record<ScribeSource, SourceStatus>;
  /** Recent per-file errors, newest last, bounded — the failure philosophy
   *  surfaced: nothing fails silently. */
  errors: ScribeError[];
}

const MAX_ERRORS = 20;

export function emptySourceStatus(root: string, rootPresent: boolean): SourceStatus {
  return { root, rootPresent, filesSeen: 0, filesProcessed: 0, events: 0, parseErrors: 0, lastEventAt: null };
}

export function recordError(status: ScribeStatus, file: string, err: unknown): void {
  status.errors.push({
    file,
    message: err instanceof Error ? err.message : String(err),
    at: new Date().toISOString(),
  });
  if (status.errors.length > MAX_ERRORS) {
    status.errors.splice(0, status.errors.length - MAX_ERRORS);
  }
}

export function writeScribeStatus(path: string, status: ScribeStatus): void {
  status.updatedAt = new Date().toISOString();
  writeFileAtomic(path, JSON.stringify(status, null, 2) + '\n');
}

export function readScribeStatus(path: string): ScribeStatus | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ScribeStatus;
    return parsed._schema === 1 ? parsed : null;
  } catch {
    return null;
  }
}
