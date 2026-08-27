import { buildPrompt, resolveCommandArgv, runNdjsonAdapter, summarizeToolInput } from './runner.js';
import { BridgeError, type BridgeAdapter, type BridgePhase, type BridgeTask, type BridgeToolEvent, type DispatchOptions } from './types.js';

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

const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/**
 * Pure deriver: codex item events → protocol-2 tool events. item.started
 * starts an event, item.completed closes it (item.status "failed" → error).
 * agent_message items are speech, not tool calls — never derived.
 */
export function deriveCodexToolEvents(event: unknown): BridgeToolEvent[] {
  if (!isRecord(event)) return [];
  if (event.type !== 'item.started' && event.type !== 'item.completed') return [];
  if (!isRecord(event.item)) return [];
  const itemType = event.item.type ?? event.item.item_type;
  if (typeof itemType !== 'string' || !TOOL_ITEM_TYPES.has(itemType)) return [];
  const status =
    event.type === 'item.started' ? 'start' : event.item.status === 'failed' ? 'error' : 'ok';
  return [{ name: itemType, summary: summarizeToolInput(itemType, event.item), status }];
}

/**
 * Delta deriver (protocol 2), housekeeping phase only: `codex exec --json` has
 * no token-level text stream (agent speech arrives complete at item.completed),
 * so the chat path has nothing worth streaming. Reasoning items make good live
 * narration for the housekeeping wait card; agent_message items are never
 * narrated — the final one is the machine JSON report and intermediate ones
 * would read as half-answers.
 * Same unverified-on-this-machine footing as the rest of the adapter (no codex
 * binary installed) — fixture-test covered.
 */
export function createCodexDeltaDeriver(phase?: BridgePhase): (event: unknown) => string | null {
  return (event) => {
    if (phase !== 'housekeeping' || !isRecord(event)) return null;
    if (event.type === 'item.completed' && isRecord(event.item)) {
      const itemType = event.item.type ?? event.item.item_type;
      if (
        itemType === 'reasoning' &&
        typeof event.item.text === 'string' &&
        event.item.text.trim().length > 0
      ) {
        return event.item.text;
      }
    }
    return null;
  };
}

export const codexAdapter: BridgeAdapter = {
  agent: 'codex',
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string> {
    const argv = resolveCommandArgv('codex');
    const args = [...argv.slice(1), 'exec', '--json'];
    if (opts.tuning?.model !== undefined) args.push('-m', opts.tuning.model);
    if (opts.tuning?.effort !== undefined) args.push('-c', `model_reasoning_effort=${opts.tuning.effort}`);
    args.push(buildPrompt(task));
    const deriveDelta = opts.onDelta === undefined ? undefined : createCodexDeltaDeriver(task.phase);
    return runNdjsonAdapter(
      'codex',
      [argv[0] ?? 'codex', ...args],
      {
        input: '',
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        cwd: opts.cwd,
        onNdjsonEvent:
          opts.onEvent === undefined && deriveDelta === undefined
            ? undefined
            : (event) => {
                if (opts.onEvent !== undefined) {
                  for (const te of deriveCodexToolEvents(event)) opts.onEvent(te);
                }
                if (deriveDelta !== undefined && opts.onDelta !== undefined) {
                  const delta = deriveDelta(event);
                  if (delta !== null) opts.onDelta(delta);
                }
              },
      },
      extractCodexResult,
    );
  },
};
