import { loadConfig } from '../lib/config.js';
import {
  MemoryError,
  readSlice,
  readSliceTail,
  readSliceTurns,
  searchSlice,
} from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';
import { assertReaderAllowed } from '../lib/reader-scope.js';

/**
 * `previously readslice <sliceId> [selector]` — the constrained slice reader
 * for bridged client agents (phase outsourcing). Prints the slice's
 * conversation record (timeline/core.md), optionally narrowed by exactly one
 * selector:
 *
 *   --start N --end N   1-based inclusive line range
 *   --last N            the last N lines
 *   --search <text>     only lines containing <text> (case-insensitive) plus a
 *                       few lines of context, prefixed with line numbers
 *   --turns a-b         the 1-based inclusive turn range (`## Turn …` headings)
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError (not_found / invalid_id / invalid_args / invalid_data), 2 on
 * usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const READSLICE_OUTPUT_CAP = 30_000;

/** Cap the slice content; truncation is always stated explicitly. */
export function truncateSliceOutput(text: string, cap: number = READSLICE_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n…[output truncated at ${cap} chars — narrow the range with --start/--end]\n`
  );
}

interface ParsedArgs {
  sliceId: string;
  startLine?: number;
  endLine?: number;
  lastLines?: number;
  searchText?: string;
  fromTurn?: number;
  toTurn?: number;
}

const USAGE =
  'Usage: previously readslice <sliceId> [--start N --end N | --last N | --search <text> | --turns a-b]';

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const out: ParsedArgs = { sliceId: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--start' || arg === '--end' || arg === '--last') {
      const value = args[++i];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 1) {
        throw new Error(`${arg} expects a positive integer, got: ${value ?? '(missing)'}`);
      }
      if (arg === '--start') out.startLine = n;
      else if (arg === '--end') out.endLine = n;
      else out.lastLines = n;
    } else if (arg === '--search') {
      const value = args[++i];
      if (value === undefined || value.trim() === '') {
        throw new Error(`--search expects a non-empty text, got: ${value ?? '(missing)'}`);
      }
      out.searchText = value;
    } else if (arg === '--turns') {
      const value = args[++i];
      const m = /^(\d+)(?:-(\d+))?$/.exec(value ?? '');
      if (m === null) {
        throw new Error(`--turns expects a-b (1-based inclusive turn range), got: ${value ?? '(missing)'}`);
      }
      out.fromTurn = Number(m[1]);
      out.toTurn = m[2] !== undefined ? Number(m[2]) : out.fromTurn;
      if (out.fromTurn < 1) {
        throw new Error(`--turns is 1-based (expects a-b with a >= 1), got: ${value ?? ''}`);
      }
      if (out.toTurn < out.fromTurn) {
        throw new Error(`--turns expects from <= to, got: ${value ?? ''}`);
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg} (expected --start N / --end N / --last N / --search <text> / --turns a-b)`);
    } else {
      positional.push(arg);
    }
  }
  const sliceId = positional[0];
  if (sliceId === undefined || positional.length > 1) {
    throw new Error(USAGE);
  }
  out.sliceId = sliceId;
  // Selectors are mutually exclusive: one question per call.
  const selectors =
    (out.startLine !== undefined || out.endLine !== undefined ? 1 : 0) +
    (out.lastLines !== undefined ? 1 : 0) +
    (out.searchText !== undefined ? 1 : 0) +
    (out.fromTurn !== undefined ? 1 : 0);
  if (selectors > 1) {
    throw new Error('Selectors are mutually exclusive — pass only one of --start/--end, --last, --search, --turns');
  }
  return out;
}

export async function run(args: string[]): Promise<number> {
  // Phase scope gate (bridge outsourcing): refused before any arg parsing.
  const denial = assertReaderAllowed('readslice');
  if (denial !== null) {
    console.error(denial);
    return 1;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content =
      parsed.lastLines !== undefined
        ? readSliceTail(memoryRoot, parsed.sliceId, parsed.lastLines)
        : parsed.searchText !== undefined
          ? searchSlice(memoryRoot, parsed.sliceId, parsed.searchText)
          : parsed.fromTurn !== undefined
            ? readSliceTurns(memoryRoot, parsed.sliceId, parsed.fromTurn, parsed.toTurn ?? parsed.fromTurn)
            : readSlice(memoryRoot, parsed.sliceId, {
                startLine: parsed.startLine,
                endLine: parsed.endLine,
              });
    console.log(truncateSliceOutput(content).trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`readslice failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
