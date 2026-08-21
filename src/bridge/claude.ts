import { buildPrompt, resolveCommandArgv, runNdjsonAdapter, textFromContent } from './runner.js';
import { BridgeError, type BridgeAdapter, type BridgeTask, type DispatchOptions } from './types.js';

/**
 * Claude Code adapter: `claude -p --output-format stream-json --verbose
 * [--max-turns N]`, prompt piped on stdin.
 *
 * Verified on this machine against claude 2.1.204 (2026-08): --max-turns is
 * accepted (though no longer listed in --help), stream-json requires
 * --verbose, and a successful run ends with a
 * `{"type":"result","subtype":"success","is_error":false,"result":"..."}`
 * event. Prompt-via-stdin is the documented pipe usage (`-p` is "useful for
 * pipes") and avoids the Windows ~32k argv limit for large assembled contexts.
 * Auth is the user's existing subscription OAuth — we never touch keys; if
 * claude errors about auth/quota, its stderr surfaces verbatim (non-zero exit
 * → cli-error in runNdjsonAdapter).
 *
 * Turn cap: PREVIOUSLY_BRIDGE_CLAUDE_MAX_TURNS (default 25, 0/none to omit).
 * The cap exists so a runaway delegated task cannot burn quota unbounded;
 * hitting it surfaces as claude's own error_max_turns result, not a fake.
 */

const DEFAULT_MAX_TURNS = 25;

function resolveMaxTurns(): number | null {
  const raw = process.env.PREVIOUSLY_BRIDGE_CLAUDE_MAX_TURNS?.trim().toLowerCase();
  if (raw === undefined || raw === '') return DEFAULT_MAX_TURNS;
  if (raw === 'none' || raw === '0') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_TURNS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pure stream extraction, exported for tests. Result event wins; fall back
 *  to the last assistant text block; error results raise honestly. */
export function extractClaudeResult(events: unknown[]): string {
  let resultEvent: Record<string, unknown> | null = null;
  let lastAssistantText = '';
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === 'result') resultEvent = event;
    if (event.type === 'assistant' && isRecord(event.message)) {
      const text = textFromContent(event.message.content);
      if (text.trim().length > 0) lastAssistantText = text;
    }
  }
  if (resultEvent !== null) {
    const subtype = typeof resultEvent.subtype === 'string' ? resultEvent.subtype : 'unknown';
    if (resultEvent.is_error === true || subtype !== 'success') {
      const detail = typeof resultEvent.result === 'string' ? resultEvent.result : '';
      throw new BridgeError(
        'cli-error',
        `claude finished with ${subtype}: ${detail}`.trim(),
      );
    }
    if (typeof resultEvent.result === 'string' && resultEvent.result.trim().length > 0) {
      return resultEvent.result;
    }
  }
  return lastAssistantText;
}

export const claudeAdapter: BridgeAdapter = {
  agent: 'claude',
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string> {
    const argv = resolveCommandArgv('claude');
    const args = [...argv.slice(1), '-p', '--output-format', 'stream-json', '--verbose'];
    const maxTurns = resolveMaxTurns();
    if (maxTurns !== null) args.push('--max-turns', String(maxTurns));
    return runNdjsonAdapter(
      'claude',
      [argv[0] ?? 'claude', ...args],
      { input: buildPrompt(task), timeoutMs: opts.timeoutMs, signal: opts.signal, cwd: opts.cwd },
      extractClaudeResult,
    );
  },
};
