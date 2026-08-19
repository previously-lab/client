import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScribeRoots } from '../src/scribe/types.js';

/**
 * Realistic fixture lines for the two scribe sources, modeled on real
 * transcripts from this machine's ~/.claude/projects and the Codex rollout
 * format ({timestamp, type, payload} envelopes).
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

/** Write a fake agent-home layout: .claude/projects + .codex/sessions roots. */
export function makeFakeAgentHome(base: string): ScribeRoots {
  const roots: ScribeRoots = {
    'claude-code': join(base, '.claude', 'projects'),
    codex: join(base, '.codex', 'sessions'),
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
