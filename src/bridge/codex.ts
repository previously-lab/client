import { buildPrompt, resolveCommandArgv, runNdjsonAdapter } from './runner.js';
import { BridgeError, type BridgeAdapter, type BridgeTask, type DispatchOptions } from './types.js';

/**
 * Codex adapter: `codex exec --json "<prompt>"`, result text from the NDJSON
 * event stream on stdout.
 *
 * NOT verified on this machine (no codex binary installed) — the flag shape
 * and event shapes below are assumptions from Codex CLI docs, covered by
 * fixture-CLI tests instead of a real run:
 * - `codex exec [PROMPT] --json` runs non-interactively and emits NDJSON.
 * - Agent speech arrives as `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}`
 *   (older builds: `{"msg":{"type":"agent_message","message":"..."}}`).
 * - Failures arrive as `{"type":"error","message":"..."}` / `{"type":"turn.failed",...}`
 *   or a non-zero exit.
 * Instructions injection: NONE for v1 (AGENTS.md-based injection is the
 * user's own repo setup, not ours to write — design §7.2).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pure stream extraction, exported for tests. */
export function extractCodexResult(events: unknown[]): string {
  let lastText = '';
  let errorMessage: string | null = null;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === 'item.completed' && isRecord(event.item)) {
      const itemType = event.item.type ?? event.item.item_type;
      if (itemType === 'agent_message' && typeof event.item.text === 'string') {
        lastText = event.item.text;
      }
    }
    // Legacy rollout-style shape.
    if (isRecord(event.msg) && event.msg.type === 'agent_message' && typeof event.msg.message === 'string') {
      lastText = event.msg.message;
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      const message = isRecord(event.error) ? event.error.message : event.message;
      errorMessage = typeof message === 'string' ? message : JSON.stringify(event).slice(0, 500);
    }
  }
  if (errorMessage !== null && lastText.trim().length === 0) {
    throw new BridgeError('cli-error', `codex reported an error: ${errorMessage}`);
  }
  return lastText;
}

export const codexAdapter: BridgeAdapter = {
  agent: 'codex',
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string> {
    const argv = resolveCommandArgv('codex');
    const args = [...argv.slice(1), 'exec', '--json', buildPrompt(task)];
    return runNdjsonAdapter(
      'codex',
      [argv[0] ?? 'codex', ...args],
      { input: '', timeoutMs: opts.timeoutMs, signal: opts.signal, cwd: opts.cwd },
      extractCodexResult,
    );
  },
};
