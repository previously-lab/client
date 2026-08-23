import { loadConfig } from '../lib/config.js';
import { MemoryError, readCard } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously card [--slice <sliceId>]` — the constrained card reader for
 * bridged client agents (phase outsourcing). Without --slice: prints the live
 * card (`episodic/current-previously.md`). With --slice: prints that slice's
 * card snapshot (`previously.md`).
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError (not_found / invalid_id), 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const CARD_OUTPUT_CAP = 30_000;

/** Cap the card content; truncation is always stated explicitly. */
export function truncateCardOutput(text: string, cap: number = CARD_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n…[output truncated at ${cap} chars]\n`;
}

interface ParsedArgs {
  sliceId?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let sliceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--slice') {
      const value = args[++i];
      if (value === undefined) {
        throw new Error('--slice expects a slice id, got: (missing)');
      }
      sliceId = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg} (expected --slice <sliceId>)`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { sliceId };
}

export async function run(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: previously card [--slice <sliceId>]');
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content = readCard(memoryRoot, parsed.sliceId);
    console.log(truncateCardOutput(content).trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`card failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
