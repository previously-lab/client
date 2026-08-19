import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. A crash mid-write can leave the temp file behind but never a
 * half-written target — this is what makes cursors/status restart-safe.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
