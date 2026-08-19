import { resolve, sep } from 'node:path';

/**
 * Time-slice identity and on-disk layout, reimplemented from the agent repo's
 * episodic manager (`src/lib/episodic/manager.ts` / `turn-parser.ts`).
 * Logic is mirrored, not imported — the repos share no code.
 *
 * Slice id: `YYYY-MM-DD-HHMM` (start-time-bound). Legacy `YYYY-MM-DD` ids are
 * accepted for robustness, matching sliceIdToRelPath upstream.
 */
export interface SliceIdParts {
  y: string;
  m: string;
  d: string;
  /** `HHMM`; absent for legacy date-only ids. */
  hm?: string;
}

/**
 * Strictly parse a slice id. Returns null for anything that is not exactly
 * `YYYY-MM-DD-HHMM` (or legacy `YYYY-MM-DD`) with plausible calendar values.
 * Strictness here is the path-traversal defense: ids are interpolated into
 * file paths, so no separator, dot, or stray character may survive.
 */
export function parseSliceId(sliceId: string): SliceIdParts | null {
  const parts = sliceId.split('-');
  if (parts.length !== 4 && parts.length !== 3) return null;
  const [y, m, d, hm] = parts as [string, string, string, string?];
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hm === undefined) return { y, m, d };
  if (!/^\d{4}$/.test(hm)) return null;
  const hour = Number(hm.slice(0, 2));
  const minute = Number(hm.slice(2, 4));
  if (hour > 23 || minute > 59) return null;
  return { y, m, d, hm };
}

/**
 * Slices-relative directory for a validated slice id.
 * `YYYY-MM-DD-HHMM` → `YYYY/MM/DD/HHMM`; legacy `YYYY-MM-DD` → `YYYY/MM/DD`.
 */
export function sliceIdToRelDir(parts: SliceIdParts): string {
  return parts.hm !== undefined
    ? `${parts.y}/${parts.m}/${parts.d}/${parts.hm}`
    : `${parts.y}/${parts.m}/${parts.d}`;
}

/**
 * Throw unless `candidate` resolves inside `root`. Belt-and-suspenders on top
 * of strict slice-id validation — guards against future refactors of the path
 * helpers silently widening what the read tools can touch (same reasoning as
 * the agent repo's flush route allow-set).
 */
export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes memory root: ${candidate}`);
  }
  return resolved;
}
