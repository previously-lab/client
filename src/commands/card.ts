import { parseArgs } from 'node:util';
import { dispatchBridgeTask, BridgeError, resolveTimeoutMs } from '../bridge/index.js';
import {
  CARD_BOOTSTRAP_TASK,
  collectCardContext,
  emptyCard,
  formatCardContext,
  validateCardDocument,
  writeLiveCard,
} from '../lib/cardgen.js';
import { loadConfig, resolveBrainAgent } from '../lib/config.js';
import { MemoryError, readCard } from '../lib/memory.js';
import { resolvePaths } from '../lib/paths.js';
import { assertReaderAllowed } from '../lib/reader-scope.js';

/**
 * `previously card [--slice <sliceId>]` — the constrained card reader for
 * bridged client agents (phase outsourcing). Without --slice: prints the live
 * card (`episodic/current-previously.md`). With --slice: prints that slice's
 * card snapshot (`previously.md`).
 *
 * `previously card bootstrap` — build the first 前情提要 (live card) after a
 * history ingest. Three scopes:
 *   --empty            zero model calls: write the empty card skeleton
 *   (default)          ONE model call over slices from the last --window days
 *                      (default 7) — physical time, most recent first
 *   --full             ONE model call over the ENTIRE archived history
 *                      (index-level data). Estimate first; --yes to confirm.
 * Model-calling scopes require --yes: run once to see the estimate (slice
 * count, context size, which subscription CLI), re-run with --yes to spend.
 *
 * Ingested historical slices never evolve the card individually — bootstrap
 * is the ONLY way history touches the card.
 *
 * Output goes to stdout, diagnostics to stderr. Exit 0 on success, 1 on
 * MemoryError / generation failures, 2 on usage errors.
 */

/** Total stdout cap; a truncated answer ends with an explicit note. */
export const CARD_OUTPUT_CAP = 30_000;

/** Cap the card content; truncation is always stated explicitly. */
export function truncateCardOutput(text: string, cap: number = CARD_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n…[output truncated at ${cap} chars]\n`;
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;

function parseWindowDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const match = /^(\d+)d?$/.exec(raw.trim());
  if (match === null) throw new Error(`--window expects a day count like 7 or 7d, got: ${raw}`);
  const days = Number(match[1]);
  if (days < 1) throw new Error('--window must be at least 1 day');
  return days;
}

async function runBootstrap(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        empty: { type: 'boolean' },
        full: { type: 'boolean' },
        window: { type: 'string' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        agent: { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: previously card bootstrap [--empty | --window 7d | --full] [--yes] [--force] [--agent claude|codex|kimi]');
    return 2;
  }
  if (values.empty === true && (values.full === true || values.window !== undefined)) {
    console.error('--empty cannot be combined with --full/--window.');
    return 2;
  }
  if (values.full === true && values.window !== undefined) {
    console.error('--full and --window are mutually exclusive.');
    return 2;
  }

  const config = loadConfig(resolvePaths());
  const force = values.force === true;

  if (values.empty === true) {
    try {
      const { path, backupPath } = writeLiveCard(config.memoryRoot, emptyCard(), force);
      console.log(`Empty card written: ${path}`);
      if (backupPath !== null) console.log(`  backup: ${backupPath}`);
      console.log('Zero token cost. The card fills in as you use Previously.');
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  let days: number;
  let agent;
  try {
    days = parseWindowDays(values.window);
    agent = resolveBrainAgent(values.agent, config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const full = values.full === true;
  const sinceMs = full ? null : Date.now() - days * DAY_MS;
  const { entries, totalSlices } = collectCardContext(config.memoryRoot, sinceMs);
  const context = formatCardContext(entries);
  const marked = entries.filter((e) => e.marked).length;

  const scope = full ? 'the ENTIRE archived history' : `the last ${days} day(s)`;
  console.log(
    `Card bootstrap plan: ${entries.length} slice(s) in scope (${scope}; ${marked} marked, ` +
      `${entries.length - marked} dry with first-line fallback), context ≈ ${context.length} chars, ` +
      `1 model call via ${agent} (your subscription).`,
  );
  if (full) {
    console.log(
      `WARNING: --full replays all ${totalSlices} slices in scope selection. This is a long, ` +
        'token-heavy call. The default 7-day window is almost always the right choice.',
    );
  }
  if (entries.length === 0) {
    console.log('Nothing in scope. Ingest history first (`previously ingest --source ...`), or use --empty.');
    return 1;
  }
  if (values.yes !== true) {
    console.log('This spends tokens. Re-run with --yes to confirm (one confirmation per call).');
    return 0;
  }

  try {
    const text = await dispatchBridgeTask(
      agent,
      { task: CARD_BOOTSTRAP_TASK, context },
      { timeoutMs: resolveTimeoutMs(agent) },
    );
    const { card, error } = validateCardDocument(text);
    if (card === null) {
      console.error(`The ${agent} reply was not a valid card: ${error}. Nothing was written; re-run to retry.`);
      return 1;
    }
    const { path, backupPath } = writeLiveCard(config.memoryRoot, card, force);
    console.log(`Card written: ${path}`);
    if (backupPath !== null) console.log(`  backup: ${backupPath}`);
    return 0;
  } catch (err) {
    if (err instanceof BridgeError) {
      console.error(`card bootstrap (${agent}) failed [${err.reason}]: ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
}

interface ParsedArgs {
  sliceId?: string;
}

function parseReaderArgs(args: string[]): ParsedArgs {
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
      throw new Error(`Unknown flag: ${arg} (expected --slice <sliceId>, or the bootstrap subcommand)`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { sliceId };
}

export async function run(args: string[]): Promise<number> {
  // Phase scope gate (bridge outsourcing): the read forms are allowed in chat
  // and housekeeping; `bootstrap` (token-spending init) is refused under ANY
  // non-empty scope — bridge calls never run it.
  const bootstrap = args[0] === 'bootstrap';
  const denial = assertReaderAllowed(bootstrap ? 'card bootstrap' : 'card');
  if (denial !== null) {
    console.error(denial);
    return 1;
  }

  if (bootstrap) {
    return runBootstrap(args.slice(1));
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseReaderArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: previously card [--slice <sliceId>] | previously card bootstrap [...]');
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
