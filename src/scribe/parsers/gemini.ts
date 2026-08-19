import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Gemini CLI chat checkpoint parser (`~/.gemini/tmp/<project_hash>/chats/*.json`).
 *
 * ASSUMED format — no Gemini CLI installation or real `~/.gemini/tmp/` exists
 * on the dev machine to verify against (re-checked this batch: binary absent).
 * Assumptions encoded here (each covered by fixture tests, marked ASSUMED):
 * - Each chat file is ONE whole JSON document (Gemini checkpoints rewrite the
 *   whole file on every save; they are NOT append-only JSONL). The engine
 *   therefore re-reads and re-derives the transcript on every change
 *   (`wholeFile` in the parser registry), relying on content-hash cursors and
 *   deterministic slice rendering to stay idempotent.
 * - Document shape: `{ sessionId, projectHash, startTime, lastUpdated,
 *   messages: [...] }`.
 * - Each message: `{ id, timestamp: ISO-8601 string, type, content, ... }`
 *   with `type` one of `user` | `gemini` | `info` | `warning` | `error` |
 *   `tool_group`; `content` is a string or an array of `{ text }` parts;
 *   `gemini` messages may carry `toolCalls: [{ name, args }]`.
 * - Gemini's retention/cleanup may delete chat files mid-watch: handled by
 *   the engine's unlink path (cursor removed, slice kept, no crash).
 *
 * Unlike the line parsers, a whole-document parse failure cannot preserve the
 * raw input verbatim (a chat checkpoint can be megabytes); the appendix then
 * holds a capped preview of the document instead. Per-message failures keep
 * the full message JSON (messages are small).
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const GEMINI_PARSER_VERSION = 1;

const DOC_PREVIEW_MAX = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Capped stand-in for a raw document that cannot be preserved verbatim. */
function docPreview(doc: string): string {
  return doc.length > DOC_PREVIEW_MAX
    ? `${doc.slice(0, DOC_PREVIEW_MAX)}\n… [truncated, ${doc.length} bytes total]`
    : doc;
}

/** Extract text from a string or `[{ text }]` content shape; "" when none. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter((text) => text.trim().length > 0);
  return texts.join('\n\n');
}

export function parseGeminiDoc(doc: string): ParseOutcome {
  let rec: unknown;
  try {
    rec = JSON.parse(doc);
  } catch {
    return { events: [], appendix: [docPreview(doc)] };
  }
  if (!isRecord(rec) || !Array.isArray(rec.messages)) {
    return { events: [], appendix: [docPreview(doc)] };
  }

  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : undefined;
  const events: TranscriptEvent[] = [];
  const appendix: string[] = [];

  for (const message of rec.messages) {
    if (!isRecord(message)) continue;
    const type = message.type;
    if (type !== 'user' && type !== 'gemini') continue; // info/warning/error/tool_group/…

    const role = type === 'user' ? 'user' : 'agent';
    const timestamp = typeof message.timestamp === 'string' ? message.timestamp : null;

    const text = contentText(message.content);
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls.filter((c): c is Record<string, unknown> => isRecord(c))
      : [];
    if (text.trim().length === 0 && toolCalls.length === 0) continue;

    if (timestamp === null) {
      // Conversational content we cannot place in time — format drift.
      try {
        appendix.push(JSON.stringify(message));
      } catch {
        appendix.push('(unserializable gemini message)');
      }
      continue;
    }

    if (text.trim().length > 0) events.push({ timestamp, role, text });
    for (const call of toolCalls) {
      if (typeof call.name !== 'string') continue;
      let argsSummary: string;
      try {
        argsSummary = truncate(JSON.stringify(call.args ?? {}) ?? '');
      } catch {
        argsSummary = `(${call.name} args not serializable)`;
      }
      events.push({ timestamp, role: 'agent', toolName: call.name, text: argsSummary });
    }
  }

  return { events, appendix, sessionId };
}
