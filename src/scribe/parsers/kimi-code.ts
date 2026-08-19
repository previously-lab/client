import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Kimi Code wire parser (`~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/<agent>/wire.jsonl`).
 *
 * VERIFIED against 82 real wire.jsonl files on the dev machine (protocol
 * version 1.5). Each line is a JSON event with an epoch-ms `time` field.
 * Conversational events:
 *   {"type":"context.append_message",
 *    "message":{"role":"user","content":[{"type":"text","text":...}]},
 *    "time":1787131307922}
 *   {"type":"context.append_loop_event","event":{"type":"content.part",
 *    "part":{"type":"text","text":...}},"time":...}        (agent speech)
 *   {"type":"context.append_loop_event","event":{"type":"tool.call",
 *    "name":"Bash","args":{...}},"time":...}               (agent tool call)
 * Verified across all sampled files: `append_message` only ever carries
 * role "user" (content blocks `text`, rarely `image_url`); assistant output
 * only ever appears as `content.part` parts of type `text`/`think`.
 * `turn.prompt` duplicates the same user text that `append_message` already
 * carries (verified 16/16 overlap in a sampled session) — skipped to avoid
 * double transcription.
 * Harness noise (`metadata`, `profile.bind`, `permission.set_mode`,
 * `config.update`, `llm.request`, `llm.tools_snapshot`, `usage.record`,
 * `tools.update_store`, `turn.ended`, `turn.cancel`, `interaction.*`,
 * `interruptionReminder.recorded`, `step.begin/end`, `tool.result`,
 * `content.part` think parts) is skipped quietly.
 *
 * The wire format carries no session id in-band; the engine derives it from
 * the file path via `kimiSessionIdFromPath`.
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const KIMI_CODE_PARSER_VERSION = 1;

const SKIP: ParseOutcome = { events: [], appendix: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Truncated, single-paragraph summary of a tool call's args. */
function summarizeToolArgs(name: string, args: unknown): string {
  if (isRecord(args)) {
    const preferred =
      args.command ?? args.file_path ?? args.pattern ?? args.prompt ?? args.query ?? args.url;
    if (typeof preferred === 'string') return truncate(preferred);
  }
  try {
    return truncate(JSON.stringify(args) ?? '');
  } catch {
    return `(${name} args not serializable)`;
  }
}

/** wire.jsonl timestamps are epoch milliseconds; convert to the ISO contract. */
function toIso(time: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Join the text blocks of a message content array; "" when none. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0);
  return texts.join('\n\n');
}

/**
 * Derive the session id from the wire file's path, e.g.
 * `.../sessions/wd_proj_ab12/session_159b57a1-…/agents/main/wire.jsonl`
 * → `session_159b57a1-…/main`. Returns undefined when the path does not
 * match the expected layout (the engine falls back to the file basename).
 */
export function kimiSessionIdFromPath(filePath: string): string | undefined {
  const match = /(session_[^/\\]+)[/\\]agents[/\\]([^/\\]+)[/\\]wire\.jsonl$/i.exec(filePath);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function parseKimiCodeLine(line: string): ParseOutcome {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return { events: [], appendix: [line] };
  }
  if (!isRecord(rec)) return { events: [], appendix: [line] };

  if (rec.type === 'context.append_message') {
    const message = rec.message;
    if (!isRecord(message)) return { events: [], appendix: [line] };
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'agent' : null;
    if (role === null) return SKIP;
    const text = contentText(message.content);
    if (text.trim().length === 0) return SKIP; // e.g. image-only messages
    const timestamp = toIso(rec.time);
    if (timestamp === null) return { events: [], appendix: [line] };
    return { events: [{ timestamp, role, text }], appendix: [] };
  }

  if (rec.type === 'context.append_loop_event') {
    const event = rec.event;
    if (!isRecord(event)) return { events: [], appendix: [line] };

    if (event.type === 'content.part') {
      const part = event.part;
      if (!isRecord(part) || part.type !== 'text') return SKIP; // think parts etc.
      if (typeof part.text !== 'string' || part.text.trim().length === 0) return SKIP;
      const timestamp = toIso(rec.time);
      if (timestamp === null) return { events: [], appendix: [line] };
      const out: TranscriptEvent = { timestamp, role: 'agent', text: part.text };
      return { events: [out], appendix: [] };
    }

    if (event.type === 'tool.call') {
      if (typeof event.name !== 'string') return SKIP;
      const timestamp = toIso(rec.time);
      if (timestamp === null) return { events: [], appendix: [line] };
      return {
        events: [
          {
            timestamp,
            role: 'agent',
            toolName: event.name,
            text: summarizeToolArgs(event.name, event.args),
          },
        ],
        appendix: [],
      };
    }

    // step.begin, step.end, tool.result, unknown loop events: skip quietly.
    return SKIP;
  }

  // metadata, profile.bind, turn.prompt (duplicate of append_message), and all
  // other harness bookkeeping: skip quietly.
  return SKIP;
}
