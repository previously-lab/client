import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Codex rollout parser (`~/.codex/sessions/**\ /rollout-*.jsonl`).
 *
 * Current rollout lines are enveloped as
 *   {"timestamp":"...","type":"response_item","payload":{...}}
 * Conversational payloads:
 *   {"type":"message","role":"user","content":[{"type":"input_text","text":...}]}
 *   {"type":"message","role":"assistant","content":[{"type":"output_text","text":...}]}
 *   {"type":"function_call","name":"shell","arguments":"{...}","call_id":"..."}
 *   {"type":"custom_tool_call","name":"...","input":"...","call_id":"..."}
 *   {"type":"local_shell_call","action":{"type":"exec","command":[...]}}
 * `session_meta` carries the session id (`payload.id`); `turn_context`,
 * `event_msg`, `reasoning`, `function_call_output`, and unknown future types
 * are skipped quietly.
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const CODEX_PARSER_VERSION = 1;

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
    events.push({ timestamp, role, text });
    return { events, appendix: [] };
  }

  if (payload.type === 'function_call' && typeof payload.name === 'string') {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const args = typeof payload.arguments === 'string' ? payload.arguments : '';
    events.push({ timestamp, role: 'agent', toolName: payload.name, text: truncate(args) });
    return { events, appendix: [] };
  }

  if (payload.type === 'custom_tool_call' && typeof payload.name === 'string') {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const input = typeof payload.input === 'string' ? payload.input : '';
    events.push({ timestamp, role: 'agent', toolName: payload.name, text: truncate(input) });
    return { events, appendix: [] };
  }

  if (payload.type === 'local_shell_call' && isRecord(payload.action)) {
    if (timestamp === undefined) return { events: [], appendix: [line] };
    const command = Array.isArray(payload.action.command)
      ? payload.action.command.filter((p): p is string => typeof p === 'string').join(' ')
      : '';
    events.push({ timestamp, role: 'agent', toolName: 'shell', text: truncate(command) });
    return { events, appendix: [] };
  }

  // reasoning, function_call_output, web_search_call, unknown payloads: skip.
  return SKIP;
}
