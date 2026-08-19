import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScribeRoots } from '../src/scribe/types.js';

/**
 * Realistic fixture lines for the four scribe sources, modeled on real
 * transcripts from this machine's ~/.claude/projects, ~/.kimi-code/sessions
 * (wire.jsonl, protocol 1.5 — VERIFIED against 82 real files), the Codex
 * rollout format ({timestamp, type, payload} envelopes), and the ASSUMED
 * Gemini CLI checkpoint shape (no real ~/.gemini/tmp on the dev machine).
 */

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export function claudeUserLine(text: string, timestamp: string, sessionId: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId: uuid(),
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid(),
    timestamp,
    permissionMode: 'default',
    origin: { kind: 'human' },
    promptSource: 'typed',
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:\\Users\\Dream\\proj',
    sessionId,
    version: '2.1.204',
    gitBranch: 'main',
  });
}

export type ClaudeBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: unknown };

export function claudeAssistantLine(blocks: ClaudeBlock[], timestamp: string, sessionId: string): string {
  const content = blocks.map((block, i) =>
    block.kind === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'tool_use', id: `toolu_${i}`, name: block.name, input: block.input },
  );
  return JSON.stringify({
    parentUuid: uuid(),
    isSidechain: false,
    type: 'assistant',
    message: {
      id: `msg_${uuid()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content,
      stop_reason: blocks.some((b) => b.kind === 'tool_use') ? 'tool_use' : 'end_turn',
    },
    uuid: uuid(),
    timestamp,
    sessionId,
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:\\Users\\Dream\\proj',
    version: '2.1.204',
  });
}

/** A tool-result user line (recognized, but not human speech → skipped). */
export function claudeToolResultLine(output: string, timestamp: string, sessionId: string): string {
  return JSON.stringify({
    parentUuid: uuid(),
    isSidechain: false,
    promptId: uuid(),
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: output }],
    },
    uuid: uuid(),
    timestamp,
    toolUseResult: output,
    sessionId,
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:\\Users\\Dream\\proj',
    version: '2.1.204',
  });
}

/** Non-conversational Claude Code lines (skipped quietly). */
export function claudeMetaLines(sessionId: string): string[] {
  return [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
    JSON.stringify({
      type: 'file-history-snapshot',
      messageId: uuid(),
      snapshot: { messageId: uuid(), trackedFileBackups: {}, timestamp: '2026-08-10T14:00:00.000Z' },
      isSnapshotUpdate: false,
    }),
    JSON.stringify({
      parentUuid: uuid(),
      isSidechain: false,
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 1234,
      timestamp: '2026-08-10T14:00:01.000Z',
      uuid: uuid(),
      isMeta: false,
      sessionId,
    }),
  ];
}

export function codexSessionMetaLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp,
      cwd: 'C:\\Users\\Dream\\proj',
      originator: 'codex_cli_rs',
      cli_version: '0.23.0',
      instructions: null,
      source: 'cli',
      model_provider: 'openai',
    },
  });
}

export function codexMessageLine(
  role: 'user' | 'assistant',
  text: string,
  timestamp: string,
): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  });
}

export function codexFunctionCallLine(name: string, args: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: args, call_id: `call_${uuid()}` },
  });
}

export function codexFunctionCallOutputLine(output: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: `call_${uuid()}`, output },
  });
}

export function codexEnvironmentContextLine(timestamp: string): string {
  return codexMessageLine(
    'user',
    '<environment_context>\n  <cwd>C:\\Users\\Dream\\proj</cwd>\n</environment_context>',
    timestamp,
  );
}

/** Write a fake agent-home layout: all four scribe roots. */
export function makeFakeAgentHome(base: string): ScribeRoots {
  const roots: ScribeRoots = {
    'claude-code': join(base, '.claude', 'projects'),
    codex: join(base, '.codex', 'sessions'),
    'kimi-code': join(base, '.kimi-code', 'sessions'),
    gemini: join(base, '.gemini', 'tmp'),
  };
  return roots;
}

/** Write a Claude Code session log file under the fake root. Returns its path. */
export function writeClaudeSession(
  roots: ScribeRoots,
  sessionId: string,
  lines: string[],
  projectSlug = 'C--Users-Dream-proj',
): string {
  const dir = join(roots['claude-code'], projectSlug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/** Write a Codex rollout log under the fake root. Returns its path. */
export function writeCodexSession(roots: ScribeRoots, name: string, lines: string[]): string {
  const dir = join(roots.codex, '2026', '08', '10');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/* ---- Kimi Code wire.jsonl fixtures (VERIFIED shape, protocol 1.5) ---- */

/** User speech: context.append_message with text blocks, epoch-ms time. */
export function kimiWireUserLine(text: string, timeMs: number): string {
  return JSON.stringify({
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }] },
    time: timeMs,
  });
}

/** Agent speech: content.part loop event with a text part. */
export function kimiWireAgentTextLine(text: string, timeMs: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: uuid(),
      turnId: '0',
      step: 1,
      stepUuid: uuid(),
      part: { type: 'text', text },
    },
    time: timeMs,
  });
}

/** Agent thinking part (skipped — not user-visible speech). */
export function kimiWireThinkLine(text: string, timeMs: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: uuid(),
      turnId: '0',
      step: 1,
      stepUuid: uuid(),
      part: { type: 'think', think: text },
    },
    time: timeMs,
  });
}

/** Agent tool invocation. */
export function kimiWireToolCallLine(name: string, args: unknown, timeMs: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      uuid: uuid(),
      turnId: '0',
      step: 1,
      stepUuid: uuid(),
      toolCallId: `tool_${uuid().slice(0, 8)}`,
      name,
      args,
    },
    time: timeMs,
  });
}

/** Non-conversational wire lines (skipped quietly). Includes turn.prompt,
 *  which duplicates the append_message user text and must not double-count. */
export function kimiWireMetaLines(userText: string, timeMs: number): string[] {
  return [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: timeMs }),
    JSON.stringify({
      type: 'profile.bind',
      modelAlias: 'kimi-code/k3-256k',
      profileName: 'agent',
      systemPrompt: 'You are Kimi Code CLI…',
    }),
    JSON.stringify({ type: 'permission.set_mode', mode: 'default', time: timeMs }),
    JSON.stringify({
      type: 'turn.prompt',
      input: [{ type: 'text', text: userText }],
      origin: 'user',
      time: timeMs,
    }),
    JSON.stringify({ type: 'llm.request', requestId: uuid(), time: timeMs }),
    JSON.stringify({
      type: 'usage.record',
      usage: { input: 100, output: 50 },
      time: timeMs,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: uuid(), turnId: '0', step: 1 },
      time: timeMs,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: uuid(),
        toolCallId: `tool_${uuid().slice(0, 8)}`,
        result: { output: 'ok' },
      },
      time: timeMs,
    }),
    JSON.stringify({ type: 'turn.ended', turnId: '0', time: timeMs }),
  ];
}

/** Write a Kimi Code wire file under the fake root. Returns its path. */
export function writeKimiSession(
  roots: ScribeRoots,
  sessionDir: string,
  agentName: string,
  lines: string[],
  workDirKey = 'wd_proj_ab12cd34ef56',
): string {
  const dir = join(roots['kimi-code'], workDirKey, sessionDir, 'agents', agentName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wire.jsonl');
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/* ---- Gemini CLI checkpoint fixtures (ASSUMED shape — no real install) ---- */

export type GeminiMessage =
  | { kind: 'user'; text: string; timestamp: string }
  | {
      kind: 'gemini';
      text: string;
      timestamp: string;
      toolCalls?: { name: string; args: unknown }[];
    }
  | { kind: 'info'; text: string; timestamp: string };

/** ASSUMED document shape: one JSON object with a messages array. */
export function geminiChatDoc(sessionId: string, messages: GeminiMessage[]): string {
  return JSON.stringify(
    {
      sessionId,
      projectHash: 'ab12cd34',
      startTime: messages[0]?.timestamp ?? '2026-08-10T17:00:00.000Z',
      lastUpdated: messages[messages.length - 1]?.timestamp ?? '2026-08-10T17:00:00.000Z',
      messages: messages.map((m, i) => {
        const base = { id: `msg-${i}`, timestamp: m.timestamp };
        if (m.kind === 'user') return { ...base, type: 'user', content: [{ text: m.text }] };
        if (m.kind === 'gemini') {
          return {
            ...base,
            type: 'gemini',
            content: m.text,
            model: 'gemini-2.5-pro',
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            tokens: { input: 10, output: 20 },
          };
        }
        return { ...base, type: 'info', content: m.text };
      }),
    },
    null,
    2,
  );
}

/** Write a Gemini chat checkpoint under the fake root. Returns its path. */
export function writeGeminiSession(
  roots: ScribeRoots,
  name: string,
  doc: string,
  projectHash = 'ab12cd34',
): string {
  const dir = join(roots.gemini, projectHash, 'chats');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `session-${name}.json`);
  writeFileSync(path, doc + '\n', 'utf8');
  return path;
}
