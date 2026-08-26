import { loadConfig } from '../lib/config.js';
import { listStrands, MemoryError, readStrand } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';
import { assertReaderAllowed } from '../lib/reader-scope.js';

/**
 * `previously strands [name]` — the constrained strand reader for bridged
 * client agents (phase outsourcing). Without a name: lists every strand with
 * its slice count. With a name: prints the strand's slice ids, one per line
 * (stored `YYYY/MM/DD/HHMM` rel-paths rendered as `YYYY-MM-DD-HHMM`).
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success (an empty
 * result prints a clear "none" line), 1 on MemoryError, 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const STRANDS_OUTPUT_CAP = 30_000;

/** Cap the output; truncation is always stated explicitly. */
export function truncateStrandsOutput(text: string, cap: number = STRANDS_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n…[output truncated at ${cap} chars]\n`;
}

/** Render a stored slice rel-path (`YYYY/MM/DD/HHMM`) as a slice id. */
export function relPathToSliceId(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length === 4) return parts.join('-');
  if (parts.length === 3) return parts.join('-'); // legacy date-only id
  return relPath; // unexpected shape — report honestly, never fabricate
}

function usage(): string {
  return 'Usage: previously strands [name]';
}

export async function run(args: string[]): Promise<number> {
  // Phase scope gate (bridge outsourcing): refused before any arg parsing.
  const denial = assertReaderAllowed('strands');
  if (denial !== null) {
    console.error(denial);
    return 1;
  }

  const [name, ...rest] = args;
  if (rest.length > 0 || (name !== undefined && name.startsWith('--'))) {
    console.error(usage());
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    if (name === undefined) {
      const strands = listStrands(memoryRoot);
      const lines =
        strands.length === 0
          ? ['No strands defined yet.']
          : strands.map((s) => `${s.name} (${s.sliceCount} slice(s))`);
      console.log(truncateStrandsOutput(lines.join('\n') + '\n').trimEnd());
      return 0;
    }
    const strand = readStrand(memoryRoot, name);
    const lines =
      strand.slices.length === 0
        ? [`Strand ${JSON.stringify(name)} has no slices.`]
        : strand.slices.map(relPathToSliceId);
    console.log(truncateStrandsOutput(lines.join('\n') + '\n').trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`strands failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
