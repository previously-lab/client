import { loadConfig } from '../lib/config.js';
import { MemoryError, readTimeline, searchMemory, type SearchResult } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously recall <query>` — the constrained memory-search tool for
 * bridged client agents (phase outsourcing). POINTERS ONLY, mirroring the
 * kernel's recall contract: recall returns slice ids + brief excerpts;
 * open a slice with `previously readslice` before citing specifics.
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success (a
 * no-match result is a success), 1 on runtime errors (memory not
 * initialized), 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const RECALL_OUTPUT_CAP = 30_000;

const TIMELINE_TAIL_LINES = 20;

export interface MatchPointer {
  sliceId: string | null;
  role: 'slice' | 'index' | 'other';
}

/** Derive the slice id and file role from a memory-relative match path. */
export function describeMatchPath(path: string): MatchPointer {
  const m = /^episodic\/slices\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\//.exec(path);
  const base = path.slice(path.lastIndexOf('/') + 1);
  const role = base === 'core.md' ? 'slice' : base === '_index.json' ? 'index' : 'other';
  return { sliceId: m === null ? null : `${m[1]}-${m[2]}-${m[3]}-${m[4]}`, role };
}

/** The last slice-entry lines of the human timeline (they are pointers already).
 *  NOTE: the entry-line pattern mirrors the kernel's timeline.md writer format
 *  (`- **YYYY-MM-DD-HHMM** …`) — if that format drifts, the tail silently
 *  degrades to fewer context lines (recall itself still works). */
export function timelineTail(timeline: string, maxLines: number = TIMELINE_TAIL_LINES): string[] {
  const entries = timeline.split(/\r?\n/).filter((line) => /^- \*\*\d{4}-\d{2}-\d{2}/.test(line));
  return entries.slice(-maxLines);
}

/** Cap the assembled output; truncation is always stated explicitly. */
export function truncateOutput(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n…[output truncated at ${cap} chars — refine the query, or open a slice with \`previously readslice <sliceId>\`]\n`
  );
}

/** Assemble the pointer-only recall report. */
export function formatRecallOutput(result: SearchResult, tail: string[], cap: number = RECALL_OUTPUT_CAP): string {
  const lines: string[] = [];
  if (result.matchCount === 0) {
    lines.push(`No memory matches for ${JSON.stringify(result.query)}.`);
  } else {
    lines.push(`Recall ${JSON.stringify(result.query)} — ${result.matchCount} match(es):`);
    lines.push('');
    for (const match of result.matches) {
      const pointer = describeMatchPath(match.path);
      const where = pointer.sliceId !== null ? `${pointer.role} ${pointer.sliceId}` : pointer.role;
      lines.push(`[${where}] ${match.path}:${match.line} — ${match.text.trim()}`);
    }
    if (result.truncated) {
      lines.push(`…[more matches exist — the search itself is capped at ${result.matches.length}]`);
    }
  }
  if (tail.length > 0) {
    lines.push('', 'Timeline tail (latest slice pointers):');
    lines.push(...tail);
  }
  lines.push('', 'Open a slice with `previously readslice <sliceId>` before citing specifics.');
  return truncateOutput(lines.join('\n') + '\n', cap);
}

export async function run(args: string[]): Promise<number> {
  const [query, ...rest] = args;
  if (query === undefined || query.trim() === '' || rest.length > 0) {
    console.error('Usage: previously recall "<query>"');
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;

  let result: SearchResult;
  let tail: string[] = [];
  try {
    result = searchMemory(memoryRoot, query);
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`recall failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
  try {
    tail = timelineTail(readTimeline(memoryRoot));
  } catch (err) {
    // A missing timeline must not fail a recall that already found matches —
    // but the omission is reported honestly on stderr.
    if (err instanceof MemoryError) {
      console.error(`recall: timeline unavailable [${err.code}]: ${err.message}`);
    } else {
      throw err;
    }
  }

  console.log(formatRecallOutput(result, tail).trimEnd());
  return 0;
}
