import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fixture adapter CLIs: small node scripts that mimic each subscription CLI's
 * stream-json output, so the bridge is tested end-to-end without burning real
 * quota (design §9 — we never claim "tested against the real CLI" for these).
 *
 * Shapes mirror the real outputs captured on 2026-08:
 * - claude 2.1.204: system init → assistant tool_use → user tool_result →
 *   assistant text → result event (verified)
 * - kimi 0.34.0: meta version → assistant tool_calls → role:"tool" result →
 *   assistant content → meta resume hint (verified)
 * - codex: item.started/item.completed command_execution + agent_message
 *   events (ASSUMED — no binary on the build machine; see src/bridge/codex.ts)
 *
 * Every fixture records how it was invoked: stdin goes to FIXTURE_STDIN_OUT
 * and argv to FIXTURE_ARGV_OUT when those env vars are set, so tests can
 * assert prompt transport. FIXTURE_CWD_OUT additionally records the child's
 * cwd plus any CLAUDE.md / AGENTS.md found there (bridge workspace checks).
 */

const RECORDING_PREAMBLE = `const fs = require('node:fs');
const path = require('node:path');
let stdinData = '';
process.stdin.on('data', (d) => (stdinData += d));
process.stdin.on('end', () => {
  if (process.env.FIXTURE_STDIN_OUT) fs.writeFileSync(process.env.FIXTURE_STDIN_OUT, stdinData, 'utf8');
  if (process.env.FIXTURE_ARGV_OUT) fs.writeFileSync(process.env.FIXTURE_ARGV_OUT, JSON.stringify(process.argv.slice(2)), 'utf8');
  if (process.env.FIXTURE_CWD_OUT) {
    const read = (f) => { try { return fs.readFileSync(path.join(process.cwd(), f), 'utf8'); } catch { return null; } };
    fs.writeFileSync(process.env.FIXTURE_CWD_OUT, JSON.stringify({ cwd: process.cwd(), claudeMd: read('CLAUDE.md'), agentsMd: read('AGENTS.md') }), 'utf8');
  }
  main();
});
`;

export const FIXTURE_CLAUDE = RECORDING_PREAMBLE + `function main() {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session', tools: [] }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture claude answer' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture claude answer', num_turns: 1 }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

/** Result event reports an error (e.g. error_max_turns) while exiting 0. */
export const FIXTURE_CLAUDE_ERROR = RECORDING_PREAMBLE + `function main() {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session' }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached max turns (2)' }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

/** Emits 150 tool_use events (over the 100-event bridge cap) then a result. */
export const FIXTURE_CLAUDE_MANY_EVENTS = RECORDING_PREAMBLE + `function main() {
  const lines = [];
  for (let i = 0; i < 150; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Bash', input: { command: 'cmd ' + i } }] } }));
  }
  lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture many-events answer', num_turns: 150 }));
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

/**
 * --include-partial-messages shape (verified on claude 2.1.204): token-level
 * text_delta partials arrive as stream_event lines, interleaved with tool
 * events. Includes one input_json_delta partial, which the bridge must ignore.
 */
export const FIXTURE_CLAUDE_DELTAS = RECORDING_PREAMBLE + `function main() {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session', tools: [] }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture ' } } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' }] } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'claude delta ' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture claude delta answer' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture claude delta answer', num_turns: 2 }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

export const FIXTURE_KIMI = RECORDING_PREAMBLE + `function main() {
  const lines = [
    JSON.stringify({ role: 'meta', type: 'system.version', version: '0.0.0-fixture' }),
    JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Read', arguments: JSON.stringify({ path: 'package.json' }) } }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'tool_1', content: '{ "name": "fixture" }' }),
    JSON.stringify({ role: 'assistant', content: 'fixture kimi answer' }),
    JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'fixture' }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

export const FIXTURE_CODEX = RECORDING_PREAMBLE + `function main() {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls -la', status: 'in_progress' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls -la', status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'fixture codex answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;

/** Codex reports a failure inside the stream and exits 0. */
export const FIXTURE_CODEX_ERROR = RECORDING_PREAMBLE + `function main() {
  process.stdout.write(JSON.stringify({ type: 'error', message: 'quota exhausted' }) + '\\n');
}
`;

/** Non-zero exit with a diagnostic on stderr (auth/quota/cold-start class). */
export const FIXTURE_FAIL = `process.stderr.write('fixture auth error: not logged in\\n');
process.exit(3);
`;

/** Exits 0 with only non-JSON noise on stdout (malformed stream). */
export const FIXTURE_GARBAGE = RECORDING_PREAMBLE + `function main() {
  process.stdout.write('this is not json\\nneither is this\\n');
}
`;

/** Exits 0 with no output at all. */
export const FIXTURE_EMPTY = RECORDING_PREAMBLE + `function main() {}
`;

/** Never exits on its own (timeout / kill path). */
export const FIXTURE_HANG = RECORDING_PREAMBLE + `function main() {
  setInterval(() => {}, 1000);
}
`;

/**
 * Build a fixture claude-shape CLI script whose success result event carries
 * `reply` verbatim (marking JSON, card documents, …). When FIXTURE_MARKER is
 * set in the environment the fixture writes a marker file on invocation, so
 * tests can prove a dispatch did (or did not) happen.
 */
export function replyFixtureScript(reply: string): string {
  return RECORDING_PREAMBLE + `function main() {
  if (process.env.FIXTURE_MARKER) fs.writeFileSync(process.env.FIXTURE_MARKER, 'called', 'utf8');
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-reply' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(reply)}, num_turns: 1 }),
  ];
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;
}

export interface FixtureClis {
  claude: string;
  claudeError: string;
  claudeManyEvents: string;
  claudeDeltas: string;
  kimi: string;
  codex: string;
  codexError: string;
  fail: string;
  garbage: string;
  empty: string;
  hang: string;
}

/** Write all fixture CLIs into dir (plain CJS .js — no package.json there). */
export function writeFixtureClis(dir: string): FixtureClis {
  mkdirSync(dir, { recursive: true });
  const files: Record<keyof FixtureClis, string> = {
    claude: FIXTURE_CLAUDE,
    claudeError: FIXTURE_CLAUDE_ERROR,
    claudeManyEvents: FIXTURE_CLAUDE_MANY_EVENTS,
    claudeDeltas: FIXTURE_CLAUDE_DELTAS,
    kimi: FIXTURE_KIMI,
    codex: FIXTURE_CODEX,
    codexError: FIXTURE_CODEX_ERROR,
    fail: FIXTURE_FAIL,
    garbage: FIXTURE_GARBAGE,
    empty: FIXTURE_EMPTY,
    hang: FIXTURE_HANG,
  };
  const out = {} as FixtureClis;
  for (const [name, source] of Object.entries(files) as [keyof FixtureClis, string][]) {
    const path = join(dir, `fixture-${name}.js`);
    writeFileSync(path, source, 'utf8');
    out[name] = path;
  }
  return out;
}

/** Value for PREVIOUSLY_BRIDGE_<AGENT>_CMD pointing at a fixture script. */
export function fixtureCmd(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`;
}
