import type { ParseOutcome, TranscriptEvent } from '../types.js';

/**
 * Claude Code session log parser (`~/.claude/projects/**\/*.jsonl`).
 *
 * Each line is a JSON event; conversational ones look like:
 *   {"type":"user","message":{"role":"user","content":"..."},
 *    "uuid":"...","timestamp":"...","sessionId":"...", ...}
 *   {"type":"assistant","message":{"role":"assistant","content":[
 *      {"type":"thinking","thinking":"..."},
 *      {"type":"text","text":"..."},
 *      {"type":"tool_use","id":"...","name":"Bash","input":{...}} ]}, ...}
 * User lines whose content is an array may carry `tool_result` blocks
 * (`{tool_use_id, content, is_error}`) — those pair with tool_use by id and
 * become tool-result events, not user speech.
 *
 * Harness envelopes in user text are unwrapped (they are UI/harness chrome,
 * not conversation): `<command-name>/<command-message>/<command-args>`
 * (slash commands → `/name args`), `<local-command-caveat>` (stripped),
 * `<system-reminder>` blocks (stripped anywhere, dropped when they are the
 * whole message), `<task-notification>` (async subagent completion → a
 * cognition-side tool event, never user speech). Safety rule: envelopes are
 * only unwrapped when the (trimmed) message STARTS with the known tag —
 * tags inside ordinary prose are never touched.
 *
 * Bump PARSER_VERSION when the mapping changes; cursors record it and a
 * mismatch forces a full re-read of the file.
 */
export const CLAUDE_CODE_PARSER_VERSION = 2;

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

const COMMAND_ENVELOPE =
  /^<command-name>([^<]*)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>([^<]*)<\/command-args>)?/;
const LOCAL_COMMAND_CAVEAT = /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TASK_NOTIFICATION = /^<task-notification>([\s\S]*?)<\/task-notification>\s*/;
const TASK_NOTIFICATION_SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const LOCAL_COMMAND_STDOUT = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

interface UnwrappedUserText {
  /** User speech to transcribe; null when the message was pure harness chrome. */
  text: string | null;
  /** Cognition-side note (task-notification summary); null when none. */
  taskNote: string | null;
}

/**
 * Unwrap known harness envelopes from a user-message text. Only anchored,
 * fully-recognized envelopes are touched; anything unrecognized is returned
 * verbatim (never strip tags out of ordinary prose).
 */
export function unwrapUserEnvelope(raw: string): UnwrappedUserText {
  // system-reminder blocks are harness injections wherever they appear — strip
  // them globally, before the envelope fast-path check below.
  const withoutReminders = raw.replace(SYSTEM_REMINDER, '');
  let text = withoutReminders;
  if (!text.trimStart().startsWith('<')) {
    const cleaned = text.trim();
    return { text: cleaned === '' ? null : text, taskNote: null };
  }
  let taskNote: string | null = null;

  let trimmed = text.trim();
  const caveat = LOCAL_COMMAND_CAVEAT.exec(trimmed);
  if (caveat !== null) trimmed = trimmed.slice(caveat[0].length).trim();

  const notification = TASK_NOTIFICATION.exec(trimmed);
  if (notification !== null) {
    const summary = TASK_NOTIFICATION_SUMMARY.exec(notification[1]!);
    taskNote = truncate(summary?.[1] ?? 'subagent task finished');
    trimmed = trimmed.slice(notification[0].length).trim();
  }

  const command = COMMAND_ENVELOPE.exec(trimmed);
  if (command !== null) {
    const name = (command[1] ?? '').trim().replace(/^\/+/, '');
    const args = (command[2] ?? '').trim();
    const rendered = `/${name}${args !== '' ? ` ${args}` : ''}`;
    const rest = trimmed.slice(command[0].length).trim();
    trimmed = rest === '' ? rendered : `${rendered}\n\n${rest}`;
  }

  const stdout = LOCAL_COMMAND_STDOUT.exec(trimmed);
  if (stdout !== null) trimmed = stdout[1]!.trim();

  return { text: trimmed === '' ? null : trimmed, taskNote };
}

/** Extract the text of a tool_result block (string or content-block array). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
  }
  return '';
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
  // Subagent sidechain lines belong to the subagent's own log, not this
  // session's conversation — skip them here (separate subagents/*.jsonl
  // files are transcribed as their own sessions).
  if (rec.isSidechain === true) return { ...SKIP, sessionId };

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
      const { text, taskNote } = unwrapUserEnvelope(content);
      if (taskNote !== null) {
        events.push({ timestamp, kind: 'tool-result', toolName: 'task', text: taskNote, isError: false });
      }
      if (text !== null) events.push({ timestamp, kind: 'user', text });
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result') {
          const out = toolResultText(block.content);
          events.push({
            timestamp,
            kind: 'tool-result',
            ...(typeof block.tool_use_id === 'string' ? { toolCallId: block.tool_use_id } : {}),
            text: truncate(out, 300),
            isError: block.is_error === true,
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          const { text, taskNote } = unwrapUserEnvelope(block.text);
          if (taskNote !== null) {
            events.push({ timestamp, kind: 'tool-result', toolName: 'task', text: taskNote, isError: false });
          }
          if (text !== null && text.trim().length > 0) texts.push(text);
        }
      }
      if (texts.length > 0) events.push({ timestamp, kind: 'user', text: texts.join('\n\n') });
    }
    return { events, appendix: [], sessionId };
  }

  // assistant
  if (!Array.isArray(content)) return { events: [], appendix: [line], sessionId };
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      events.push({ timestamp, kind: 'agent-text', text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
      events.push({ timestamp, kind: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({
        timestamp,
        kind: 'tool-call',
        toolName: block.name,
        text: summarizeToolInput(block.name, block.input),
        ...(typeof block.id === 'string' ? { toolCallId: block.id } : {}),
      });
    }
  }
  return { events, appendix: [], sessionId };
}
