import { loadConfig } from '../lib/config.js';
import { MemoryError, readSliceSummary } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';
import { assertReaderAllowed } from '../lib/reader-scope.js';

/**
 * `previously slicesummary <sliceId>` — the constrained slice-summary reader
 * for bridged client agents (phase outsourcing). Prints ONLY the YAML
 * frontmatter of the slice's conversation record (focus/summary/tags/tone/
 * turns ...), never the body — open the body with `previously readslice`.
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError (not_found / invalid_id / invalid_data), 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const SLICESUMMARY_OUTPUT_CAP = 30_000;

/** Cap the summary; truncation is always stated explicitly. */
export function truncateSummaryOutput(text: string, cap: number = SLICESUMMARY_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n…[output truncated at ${cap} chars — open the slice with \`previously readslice <sliceId>\`]\n`
  );
}

export async function run(args: string[]): Promise<number> {
  // Phase scope gate (bridge outsourcing): refused before any arg parsing.
  const denial = assertReaderAllowed('slicesummary');
  if (denial !== null) {
    console.error(denial);
    return 1;
  }

  const [sliceId, ...rest] = args;
  if (sliceId === undefined || rest.length > 0) {
    console.error('Usage: previously slicesummary <sliceId>');
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content = readSliceSummary(memoryRoot, sliceId);
    console.log(truncateSummaryOutput(content).trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`slicesummary failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
