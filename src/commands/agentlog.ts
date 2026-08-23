import { loadConfig } from '../lib/config.js';
import { MemoryError, readAgentTimeline } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously agentlog <sliceId> [--start N --end N]` — the constrained
 * agent-timeline reader for bridged client agents (phase outsourcing). Prints
 * the slice's cognition record (timeline/agent.md), optionally narrowed to a
 * 1-based inclusive line range.
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError (not_found / invalid_id / invalid_args), 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const AGENTLOG_OUTPUT_CAP = 30_000;

/** Cap the cognition record; truncation is always stated explicitly. */
export function truncateAgentlogOutput(text: string, cap: number = AGENTLOG_OUTPUT_CAP): string {
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
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let startLine: number | undefined;
  let endLine: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--start' || arg === '--end') {
      const value = args[++i];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 1) {
        throw new Error(`${arg} expects a positive integer, got: ${value ?? '(missing)'}`);
      }
      if (arg === '--start') startLine = n;
      else endLine = n;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg} (expected --start N / --end N)`);
    } else {
      positional.push(arg);
    }
  }
  const sliceId = positional[0];
  if (sliceId === undefined || positional.length > 1) {
    throw new Error('Usage: previously agentlog <sliceId> [--start N --end N]');
  }
  return { sliceId, startLine, endLine };
}

export async function run(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const memoryRoot = loadConfig(resolvePaths()).memoryRoot;
  try {
    const content = readAgentTimeline(memoryRoot, parsed.sliceId, {
      startLine: parsed.startLine,
      endLine: parsed.endLine,
    });
    console.log(truncateAgentlogOutput(content).trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof MemoryError) {
      console.error(`agentlog failed [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
