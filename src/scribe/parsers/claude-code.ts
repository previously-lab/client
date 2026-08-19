import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Claude Code session log parser (`~/.claude/projects/**\/*.jsonl`).
 *
 * Each line is a JSON event; conversational ones look like:
 *   {"type":"user","message":{"role":"user","content":"..."},
 *    "uuid":"...","timestamp":"...","sessionId":"...", ...}
 *   {"type":"assistant","message":{"role":"assistant","content":[
 *      {"type":"text","text":"..."},
 *      {"type":"tool_use","name":"Bash","input":{...}} ]}, ...}
 * User lines whose content is an array of `tool_result` blocks are tool
 * results, not human speech — skipped. All other line types (`mode`,
 * `permission-mode`, `file-history-snapshot`, `attachment`, `system`,
 * `ai-title`, `last-prompt`, unknown future types) are skipped quietly.
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const CLAUDE_CODE_PARSER_VERSION = 1;

const SKIP: ParseOutcome = { events: [], appendix: [] };

/** Truncated, single-paragraph summary of a tool call's input. */
function summarizeToolInput(name: string, input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    const preferred =
      rec.command ?? rec.file_path ?? rec.pattern ?? rec.prompt ?? rec.query ?? rec.url;
    if (typeof preferred === 'string') return truncate(preferred);
  }
  try {
    return truncate(JSON.stringify(input) ?? '');
  } catch {
    return `(${name} input not serializable)`;
  }
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseClaudeCodeLine(line: string): ParseOutcome {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return { events: [], appendix: [line] };
  }
  if (!isRecord(rec)) return { events: [], appendix: [line] };

  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : undefined;
  const type = rec.type;
  if (type !== 'user' && type !== 'assistant') return { ...SKIP, sessionId };

  const timestamp = rec.timestamp;
  const message = rec.message;
  if (typeof timestamp !== 'string' || !isRecord(message)) {
    // A conversational line we cannot place in time — format drift; appendix it.
    return { events: [], appendix: [line], sessionId };
  }

  const content = message.content;
  const events: TranscriptEvent[] = [];

  if (type === 'user') {
    if (typeof content === 'string') {
      if (content.trim().length > 0) events.push({ timestamp, role: 'user', text: content });
    } else if (Array.isArray(content)) {
      const texts = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            isRecord(block) && block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .filter((text) => text.trim().length > 0);
      if (texts.length > 0) events.push({ timestamp, role: 'user', text: texts.join('\n\n') });
      // Arrays of only tool_result blocks are tool output, not speech: skip.
    }
    return { events, appendix: [], sessionId };
  }

  // assistant
  if (!Array.isArray(content)) return { events: [], appendix: [line], sessionId };
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      events.push({ timestamp, role: 'agent', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({
        timestamp,
        role: 'agent',
        toolName: block.name,
        text: summarizeToolInput(block.name, block.input),
      });
    }
  }
  return { events, appendix: [], sessionId };
}
