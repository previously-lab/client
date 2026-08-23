import { loadConfig } from '../lib/config.js';
import { MemoryError, readTimeline } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously timeline [--month YYYY-MM] [--day MM-DD]` — the constrained
 * timeline reader for bridged client agents (phase outsourcing). Prints the
 * human timeline, optionally narrowed to one month / one day section.
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
    `\n…[output truncated at ${cap} chars — narrow the view with --month/--day]\n`
  );
}

interface ParsedArgs {
  month?: string;
  day?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let month: string | undefined;
  let day: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--month' || arg === '--day') {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`${arg} expects a value, got: (missing)`);
      }
      if (arg === '--month') month = value;
      else day = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg} (expected --month YYYY-MM / --day MM-DD)`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { month, day };
}

export async function run(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: previously timeline [--month YYYY-MM] [--day MM-DD]');
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content = readTimeline(memoryRoot, { month: parsed.month, day: parsed.day });
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
