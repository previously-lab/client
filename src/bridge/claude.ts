import { buildPrompt, resolveCommandArgv, runNdjsonAdapter, summarizeToolInput, textFromContent } from './runner.js';
import { BridgeError, type BridgeAdapter, type BridgePhase, type BridgeTask, type BridgeToolEvent, type DispatchOptions } from './types.js';

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
 *
 * Text deltas (protocol 2): when the caller passes an onDelta sink, the spawn
 * gains --include-partial-messages (verified present on claude 2.1.204: it
 * makes stream-json emit {"type":"stream_event","event":{"type":
 * "content_block_delta","delta":{"type":"text_delta","text":"..."}}} partials
 * as the answer streams). Without a sink the flag is omitted, so v1 dispatches
 * stay byte-identical.
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

/**
 * Stateful deriver (one per dispatch): claude stream-json → protocol-2 tool
 * events. tool_use blocks in assistant messages start an event; tool_result
 * blocks in user messages close it (is_error → error, else ok), matched to
 * the call's name/summary via tool_use_id.
 */
export function createClaudeToolEventDeriver(): (event: unknown) => BridgeToolEvent[] {
  const calls = new Map<string, { name: string; summary: string }>();
  return (event) => {
    if (!isRecord(event) || !isRecord(event.message)) return [];
    const content = event.message.content;
    if (!Array.isArray(content)) return [];
    const out: BridgeToolEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const summary = summarizeToolInput(block.name, block.input);
        if (typeof block.id === 'string') calls.set(block.id, { name: block.name, summary });
        out.push({ name: block.name, summary, status: 'start' });
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        const call = typeof block.tool_use_id === 'string' ? calls.get(block.tool_use_id) : undefined;
        out.push({
          name: call?.name ?? 'tool',
          summary: call?.summary ?? '',
          status: block.is_error === true ? 'error' : 'ok',
        });
      }
    }
    return out;
  };
}

/**
 * Pure per-event delta extraction, exported for tests: claude's
 * --include-partial-messages stream emits
 * `{"type":"stream_event","event":{"type":"content_block_delta","delta":
 * {"type":"text_delta","text":"..."}}}` partials as the answer streams.
 * Anything else — other delta kinds, other event types, malformed shapes — is
 * ignored (never fatal); the final result event remains the source of truth.
 */
export function deltaFromClaudeEvent(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'stream_event' || !isRecord(event.event)) return null;
  const inner = event.event;
  if (inner.type !== 'content_block_delta' || !isRecord(inner.delta)) return null;
  const delta = inner.delta;
  if (delta.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text.length === 0) return null;
  return delta.text;
}

/**
 * Stateful delta deriver (one per dispatch), phase-aware:
 *
 * - Default (chat / delegateTask): every text_delta passes through — the
 *   streamed text IS the answer the user is waiting for.
 * - housekeeping: the final reply is a machine JSON report that must never
 *   reach the UI. Per content block the first non-whitespace char decides:
 *   `{` or a code fence → the whole block is suppressed; anything else → the
 *   block streams as narration (buffered prefix flushed on decision) — BUT a
 *   narration block is cut off at the first LINE that starts with `{` or a
 *   fence (`\n` + optional spaces + `{`/backtick), so a contract-violating
 *   "Here is the report:\n```json\n{…}" reply only leaks its prose head, never
 *   the JSON. False-positive cost accepted: narration that quotes JSON or
 *   inline code at line start gets cut there (housekeeping narration is
 *   thinking-aloud, not the deliverable).
 *   Thinking blocks always narrate — they are the live "what is it doing"
 *   material for the housekeeping wait indicator.
 *
 * Unknown/untracked block indexes stay silent (never fatal); the final result
 * envelope remains the source of truth regardless. Set PREVIOUSLY_BRIDGE_DEBUG
 * to get a one-shot stderr note when text deltas arrive for an untracked
 * block — that is how a silent claude event-shape change shows up (otherwise
 * indistinguishable from "claude just didn't stream").
 */
export function createClaudeDeltaDeriver(phase?: BridgePhase): (event: unknown) => string | null {
  if (phase !== 'housekeeping') {
    return (event) => deltaFromClaudeEvent(event);
  }
  interface BlockState {
    pending: string;
    decided: 'narration' | 'suppressed' | null;
    /** Narration tail held back because it may be the start of a JSON-boundary
     *  line (`\n` + spaces at a chunk edge) — flushed or cut by the next chunk. */
    held: string;
  }
  const blocks = new Map<number, BlockState>();
  let debugNoted = false;
  const debugNote = (msg: string) => {
    if (debugNoted || !process.env.PREVIOUSLY_BRIDGE_DEBUG) return;
    debugNoted = true;
    try {
      process.stderr.write(`[bridge:claude] ${msg}\n`);
    } catch {
      // diagnostics must never break the dispatch
    }
  };
  const narrate = (block: BlockState, text: string): string | null => {
    let out = block.held + text;
    block.held = '';
    // Cut the block off at the first line starting a JSON report (or its
    // code fence) — the report must never reach the narration channel.
    const boundary = /\n[ \t]*[{`]/.exec(out);
    if (boundary) {
      block.decided = 'suppressed';
      const head = out.slice(0, boundary.index);
      return head.length > 0 ? head : null;
    }
    // Hold back a trailing partial boundary (`\n` + spaces at the chunk
    // edge) so a boundary split across two chunks is still caught.
    const tail = /\n[ \t]*$/.exec(out);
    if (tail) {
      block.held = tail[0];
      out = out.slice(0, tail.index);
    }
    return out.length > 0 ? out : null;
  };
  return (event) => {
    if (!isRecord(event) || event.type !== 'stream_event' || !isRecord(event.event)) return null;
    const inner = event.event;
    const idx = typeof inner.index === 'number' ? inner.index : -1;
    if (inner.type === 'content_block_start') {
      if (idx >= 0) blocks.set(idx, { pending: '', decided: null, held: '' });
      return null;
    }
    if (inner.type === 'content_block_stop') {
      blocks.delete(idx);
      return null;
    }
    if (inner.type !== 'content_block_delta' || !isRecord(inner.delta)) return null;
    const delta = inner.delta;
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      return delta.thinking;
    }
    if (delta.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text.length === 0) return null;
    const block = blocks.get(idx);
    if (!block) {
      debugNote(`text_delta for untracked content block ${idx} — claude event shape may have changed`);
      return null;
    }
    if (block.decided === 'suppressed') return null;
    if (block.decided === 'narration') return narrate(block, delta.text);
    block.pending += delta.text;
    if (!/\S/.test(block.pending)) return null;
    const first = block.pending.trimStart()[0];
    if (first === '{' || first === '`') {
      block.decided = 'suppressed';
      return null;
    }
    block.decided = 'narration';
    // The buffered prefix goes through the same boundary check — a chunk can
    // carry both the decision char and the start of the report ("…prose\n```").
    const pending = block.pending;
    block.pending = '';
    return narrate(block, pending);
  };
}

export const claudeAdapter: BridgeAdapter = {
  agent: 'claude',
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string> {
    const argv = resolveCommandArgv('claude');
    const args = [...argv.slice(1), '-p', '--output-format', 'stream-json', '--verbose'];
    // Token-level answer deltas are only requested when a sink exists, so
    // dispatches without one (v1 protocol) stay byte-identical.
    if (opts.onDelta !== undefined) args.push('--include-partial-messages');
    const maxTurns = resolveMaxTurns();
    if (maxTurns !== null) args.push('--max-turns', String(maxTurns));
    if (opts.tuning?.model !== undefined) args.push('--model', opts.tuning.model);
    if (opts.tuning?.effort !== undefined) args.push('--effort', opts.tuning.effort);
    const derive = createClaudeToolEventDeriver();
    const deriveDelta = opts.onDelta === undefined ? undefined : createClaudeDeltaDeriver(task.phase);
    return runNdjsonAdapter(
      'claude',
      [argv[0] ?? 'claude', ...args],
      {
        input: buildPrompt(task),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        cwd: opts.cwd,
        onNdjsonEvent:
          opts.onEvent === undefined && deriveDelta === undefined
            ? undefined
            : (event) => {
                if (opts.onEvent !== undefined) {
                  for (const te of derive(event)) opts.onEvent(te);
                }
                if (deriveDelta !== undefined && opts.onDelta !== undefined) {
                  const delta = deriveDelta(event);
                  if (delta !== null) opts.onDelta(delta);
                }
              },
      },
      extractClaudeResult,
    );
  },
};
