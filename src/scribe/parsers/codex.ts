import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Codex rollout parser (`~/.codex/sessions/**\ /rollout-*.jsonl`).
 *
 * Current rollout lines are enveloped as
 *   {"timestamp":"...","type":"response_item","payload":{...}}
 * Conversational payloads:
 *   {"type":"message","role":"user","content":[{"type":"input_text","text":...}]}
 *   {"type":"message","role":"assistant","content":[{"type":"output_text","text":...}]}
 *   {"type":"reasoning","summary":[{"type":"summary_text","text":...}]}
 *   {"type":"function_call","name":"shell","arguments":"{...}","call_id":"..."}
 *   {"type":"function_call_output","call_id":"...","output":"..."}
 *   {"type":"custom_tool_call","name":"...","input":"...","call_id":"..."}
 *   {"type":"custom_tool_call_output","call_id":"...","output":"..."}
 *   {"type":"local_shell_call","action":{"type":"exec","command":[...]}}
 * `session_meta` carries the session id (`payload.id`); `turn_context`
 * (per-turn model/cwd), `compacted` (context-compaction boundary),
 * `event_msg`, and unknown future types are skipped quietly. Calls pair with
 * outputs via `call_id`.
 *
 * Format cross-checked against the openai/codex source (codex-rs history /
 * rollout / protocol crates, 2026-08): the envelope and payload shapes above
 * are source-confirmed. Still ASSUMED overall — no real rollout file has been
 * parsed on the dev machine; fixture tests carry the weight.
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const CODEX_PARSER_VERSION = 2;

const SKIP: ParseOutcome = { events: [], appendix: [] };

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Codex injects environment context as a synthetic first user message; it is
 *  harness noise, not conversation, so it is skipped. */
function isInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<environment_context>') || trimmed.startsWith('<user_instructions>');
}

function messageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return '';
  const texts: string[] = [];
  for (const block of payload.content) {
    if (!isRecord(block)) continue;
    if (
      (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') &&
      typeof block.text === 'string'
    ) {
      texts.push(block.text);
    }
  }
  return texts.join('\n\n');
}

export function parseCodexLine(line: string): ParseOutcome {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return { events: [], appendix: [line] };
  }
  if (!isRecord(rec)) return { events: [], appendix: [line] };

  const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;

  // session_meta is not conversational but carries the session id.
  if (rec.type === 'session_meta') {
    const payload = rec.payload;
    const sessionId =
      isRecord(payload) && typeof payload.id === 'string' ? payload.id : undefined;
    return { ...SKIP, sessionId };
  }

  if (rec.type !== 'response_item' || !isRecord(rec.payload)) return SKIP;
  const payload = rec.payload;
  const events: TranscriptEvent[] = [];

  if (payload.type === 'message') {
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'agent' : null;
    if (role === null) return SKIP;
    const text = messageText(payload);
    if (text.trim().length === 0 || isInjectedContext(text)) return SKIP;
    if (timestamp === undefined) {
      // Conversational content we cannot place in time — format drift.
      return { events: [], appendix: [line] };
    }
    events.push({ timestamp, kind: role === 'user' ? 'user' : 'agent-text', text });
    return { events, appendix: [] };
  }

  if (payload.type === 'reasoning') {
    if (timestamp === undefined) return SKIP; // reasoning without a time is skippable noise
    const summary = Array.isArray(payload.summary) ? payload.summary : [];
    const texts = summary
      .filter((s): s is Record<string, unknown> => isRecord(s))
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .filter((t) => t.trim().length > 0);
    if (texts.length === 0) return SKIP;
    events.push({ timestamp, kind: 'thinking', text: texts.join('\n\n') });
    return { events, appendix: [] };
  }

  if (payload.type === 'function_call' && typeof payload.name === 'string') {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const args = typeof payload.arguments === 'string' ? payload.arguments : '';
    events.push({
      timestamp,
      kind: 'tool-call',
      toolName: payload.name,
      text: truncate(args),
      ...(typeof payload.call_id === 'string' ? { toolCallId: payload.call_id } : {}),
    });
    return { events, appendix: [] };
  }

  if (payload.type === 'custom_tool_call' && typeof payload.name === 'string') {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const input = typeof payload.input === 'string' ? payload.input : '';
    events.push({
      timestamp,
      kind: 'tool-call',
      toolName: payload.name,
      text: truncate(input),
      ...(typeof payload.call_id === 'string' ? { toolCallId: payload.call_id } : {}),
    });
    return { events, appendix: [] };
  }

  if (payload.type === 'local_shell_call' && isRecord(payload.action)) {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const command = Array.isArray(payload.action.command)
      ? payload.action.command.filter((p): p is string => typeof p === 'string').join(' ')
      : '';
    events.push({
      timestamp,
      kind: 'tool-call',
      toolName: 'shell',
      text: truncate(command),
      ...(typeof payload.call_id === 'string' ? { toolCallId: payload.call_id } : {}),
    });
    return { events, appendix: [] };
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    if (timestamp === undefined) return SKIP;
    const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
    events.push({
      timestamp,
      kind: 'tool-result',
      ...(typeof payload.call_id === 'string' ? { toolCallId: payload.call_id } : {}),
      text: truncate(output, 300),
      isError: false,
    });
    return { events, appendix: [] };
  }

  // web_search_call, unknown payloads: skip.
  return SKIP;
}
