import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

/**
 * Simple size-capped log rotation (design doc §9: logs must not grow
 * forever). When `logPath` exceeds `maxBytes`, it is renamed to
 * `logPath.1`, older backups shift up (`…​.1` → `…​.2`, …), and the oldest
 * beyond `keep` is deleted.
 *
 * Rotation happens at spawn time — right before a fresh daemon opens the log
 * — so no live writer holds the file being renamed. Best-effort: if a rename
 * fails (e.g. a stray process still holds the file on Windows), the log is
 * left alone rather than failing the spawn.
 */

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Returns true when rotation actually happened. */
export function rotateLogIfOversize(
  logPath: string,
  maxBytes: number = LOG_MAX_BYTES,
  keep: number = LOG_KEEP,
): boolean {
  try {
    if (!existsSync(logPath)) return false;
    if (statSync(logPath).size <= maxBytes) return false;
    rmSync(`${logPath}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
    }
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}
