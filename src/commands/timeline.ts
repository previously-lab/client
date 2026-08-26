import { loadConfig } from '../lib/config.js';
import { MemoryError, readTimeline } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';
import { assertReaderAllowed } from '../lib/reader-scope.js';

/**
 * `previously timeline [--month YYYY-MM] [--day MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]`
 * — the constrained timeline reader for bridged client agents (phase
 * outsourcing). Prints the human timeline, optionally narrowed to one
 * month / one day section, or to an inclusive date window (--from/--to,
 * mutually exclusive with --month/--day).
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError (not_found / invalid_args), 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const TIMELINE_OUTPUT_CAP = 30_000;

/** Cap the timeline content; truncation is always stated explicitly. */
export function truncateTimelineOutput(text: string, cap: number = TIMELINE_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n…[output truncated at ${cap} chars — narrow the view with --month/--day or --from/--to]\n`
  );
}

interface ParsedArgs {
  month?: string;
  day?: string;
  from?: string;
  to?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--month' || arg === '--day' || arg === '--from' || arg === '--to') {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`${arg} expects a value, got: (missing)`);
      }
      if (arg === '--month') out.month = value;
      else if (arg === '--day') out.day = value;
      else if (arg === '--from') out.from = value;
      else out.to = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg} (expected --month YYYY-MM / --day MM-DD / --from YYYY-MM-DD / --to YYYY-MM-DD)`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return out;
}

export async function run(args: string[]): Promise<number> {
  // Phase scope gate (bridge outsourcing): refused before any arg parsing.
  const denial = assertReaderAllowed('timeline');
  if (denial !== null) {
    console.error(denial);
    return 1;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: previously timeline [--month YYYY-MM] [--day MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]');
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content = readTimeline(memoryRoot, {
      month: parsed.month,
      day: parsed.day,
      from: parsed.from,
      to: parsed.to,
    });
    console.log(truncateTimelineOutput(content).trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`timeline failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
