import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter, createClaudeToolEventDeriver, extractClaudeResult } from '../src/bridge/claude.js';
import { codexAdapter, deriveCodexToolEvents, extractCodexResult } from '../src/bridge/codex.js';
import { createKimiToolEventDeriver, extractKimiResult, kimiAdapter } from '../src/bridge/kimi.js';
import { checkCliPresence, resolveTimeoutMs, splitCommand } from '../src/bridge/runner.js';
import { BridgeError } from '../src/bridge/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, writeFixtureClis, type FixtureClis } from './bridge-fixtures.js';

const BRIDGE_ENV_KEYS = [
  'PREVIOUSLY_BRIDGE_CLAUDE_CMD',
  'PREVIOUSLY_BRIDGE_CODEX_CMD',
  'PREVIOUSLY_BRIDGE_KIMI_CMD',
  'PREVIOUSLY_BRIDGE_CLAUDE_TIMEOUT_MS',
  'PREVIOUSLY_BRIDGE_CODEX_TIMEOUT_MS',
  'PREVIOUSLY_BRIDGE_KIMI_TIMEOUT_MS',
  'PREVIOUSLY_BRIDGE_TIMEOUT_MS',
  'PREVIOUSLY_BRIDGE_CLAUDE_MAX_TURNS',
  'FIXTURE_STDIN_OUT',
  'FIXTURE_ARGV_OUT',
];

describe('bridge adapters', () => {
  let home: string;
  let fixtures: FixtureClis;

  beforeEach(() => {
    home = useTempHome();
    fixtures = writeFixtureClis(join(home, 'fixtures'));
  });
  afterEach(() => {
    for (const key of BRIDGE_ENV_KEYS) delete process.env[key];
    cleanupTempHome(home);
  });

  describe('pure stream extraction', () => {
    it('claude: result event text wins', () => {
      const events = [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'final answer' },
      ];
      expect(extractClaudeResult(events)).toBe('final answer');
    });

    it('claude: falls back to the last assistant text when no result event', () => {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
      ];
      expect(extractClaudeResult(events)).toBe('second');
    });

    it('claude: error result event raises cli-error with the detail', () => {
      const events = [{ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached max turns (2)' }];
      expect(() => extractClaudeResult(events)).toThrowError(/error_max_turns: Reached max turns/);
    });

    it('kimi: last assistant content wins, meta events ignored', () => {
      const events = [
        { role: 'meta', type: 'system.version', version: '0.34.0' },
        { role: 'assistant', content: 'PONG' },
        { role: 'meta', type: 'session.resume_hint', session_id: 'x' },
      ];
      expect(extractKimiResult(events)).toBe('PONG');
    });

    it('codex: item.completed agent_message text wins', () => {
      const events = [
        { type: 'thread.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'codex says hi' } },
        { type: 'turn.completed' },
      ];
      expect(extractCodexResult(events)).toBe('codex says hi');
    });

    it('codex: legacy msg shape also extracts', () => {
      const events = [{ msg: { type: 'agent_message', message: 'legacy text' } }];
      expect(extractCodexResult(events)).toBe('legacy text');
    });

    it('codex: stream error event with no answer raises cli-error', () => {
      const events = [{ type: 'error', message: 'quota exhausted' }];
      expect(() => extractCodexResult(events)).toThrowError(/quota exhausted/);
    });
  });

  describe('tool-event derivers (protocol 2)', () => {
    it('claude: tool_use starts, tool_result closes with matched name and ok/error', () => {
      const derive = createClaudeToolEventDeriver();
      expect(
        derive({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] },
        }),
      ).toEqual([{ name: 'Bash', summary: 'ls -la', status: 'start' }]);
      expect(
        derive({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' }] },
        }),
      ).toEqual([{ name: 'Bash', summary: 'ls -la', status: 'ok' }]);
      expect(
        derive({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }] },
        }),
      ).toEqual([{ name: 'Bash', summary: 'ls -la', status: 'error' }]);
      // Text blocks and unknown ids are not tool events.
      expect(derive({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([]);
      expect(
        derive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope' }] } }),
      ).toEqual([{ name: 'tool', summary: '', status: 'ok' }]);
    });

    it('codex: item.started/completed on tool item types; agent_message is speech', () => {
      expect(
        deriveCodexToolEvents({
          type: 'item.started',
          item: { type: 'command_execution', command: 'ls -la', status: 'in_progress' },
        }),
      ).toEqual([{ name: 'command_execution', summary: 'ls -la', status: 'start' }]);
      expect(
        deriveCodexToolEvents({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'ls -la', status: 'completed' },
        }),
      ).toEqual([{ name: 'command_execution', summary: 'ls -la', status: 'ok' }]);
      expect(
        deriveCodexToolEvents({
          type: 'item.completed',
          item: { type: 'web_search', query: 'previously kernel', status: 'failed' },
        }),
      ).toEqual([{ name: 'web_search', summary: 'previously kernel', status: 'error' }]);
      expect(
        deriveCodexToolEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
      ).toEqual([]);
    });

    it('kimi: tool_calls starts (arguments JSON parsed), role:tool closes ok', () => {
      const derive = createKimiToolEventDeriver();
      expect(
        derive({
          role: 'assistant',
          tool_calls: [
            { type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{"path":"package.json"}' } },
          ],
        }),
      ).toEqual([{ name: 'Read', summary: 'package.json', status: 'start' }]);
      // Kimi emits no error flag on tool results — honestly always ok.
      expect(derive({ role: 'tool', tool_call_id: 'tool_1', content: '...' })).toEqual([
        { name: 'Read', summary: 'package.json', status: 'ok' },
      ]);
      // Plain assistant speech and meta lines degrade to no events.
      expect(derive({ role: 'assistant', content: 'answer' })).toEqual([]);
      expect(derive({ role: 'meta', type: 'system.version' })).toEqual([]);
    });
  });

  describe('dispatch through fixture CLIs', () => {
    it('claude: pipes the assembled prompt on stdin and returns the result text', async () => {
      const stdinOut = join(home, 'stdin.txt');
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
      process.env.FIXTURE_STDIN_OUT = stdinOut;
      process.env.FIXTURE_ARGV_OUT = argvOut;

      const text = await claudeAdapter.dispatch(
        { task: 'do the thing', context: 'assembled memory context' },
        { timeoutMs: 10_000 },
      );
      expect(text).toBe('fixture claude answer');

      const prompt = readFileSync(stdinOut, 'utf8');
      expect(prompt).toContain('assembled memory context');
      expect(prompt).toContain('do the thing');
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv).toContain('-p');
      expect(argv).toContain('stream-json');
      expect(argv).toContain('--verbose');
      expect(argv).toContain('--max-turns');
    });

    it('claude: task-only dispatch sends the bare task without context wrapper', async () => {
      const stdinOut = join(home, 'stdin.txt');
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
      process.env.FIXTURE_STDIN_OUT = stdinOut;

      await claudeAdapter.dispatch({ task: 'just the task', context: null }, { timeoutMs: 10_000 });
      expect(readFileSync(stdinOut, 'utf8')).toBe('just the task');
    });

    it('kimi: passes the prompt via argv and returns the last assistant content', async () => {
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
      process.env.FIXTURE_ARGV_OUT = argvOut;

      const text = await kimiAdapter.dispatch({ task: 'kimi task', context: 'ctx' }, { timeoutMs: 10_000 });
      expect(text).toBe('fixture kimi answer');
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv[0]).toBe('-p');
      expect(argv[1]).toContain('kimi task');
      expect(argv[1]).toContain('ctx');
      expect(argv.slice(2)).toEqual(['--output-format', 'stream-json']);
    });

    it('codex: runs exec --json and returns the agent message text', async () => {
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
      process.env.FIXTURE_ARGV_OUT = argvOut;

      const text = await codexAdapter.dispatch({ task: 'codex task' }, { timeoutMs: 10_000 });
      expect(text).toBe('fixture codex answer');
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv[0]).toBe('exec');
      expect(argv[1]).toBe('--json');
      expect(argv[2]).toBe('codex task');
    });

    it('claude: tuning appends --model and --effort', async () => {
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
      process.env.FIXTURE_ARGV_OUT = argvOut;

      await claudeAdapter.dispatch(
        { task: 't' },
        { timeoutMs: 10_000, tuning: { model: 'claude-opus-4-8', effort: 'high' } },
      );
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv.slice(-4)).toEqual(['--model', 'claude-opus-4-8', '--effort', 'high']);
    });

    it('codex: tuning appends -m and -c model_reasoning_effort before the prompt', async () => {
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
      process.env.FIXTURE_ARGV_OUT = argvOut;

      await codexAdapter.dispatch(
        { task: 'codex task' },
        { timeoutMs: 10_000, tuning: { model: 'gpt-5.3-codex', effort: 'low' } },
      );
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv).toEqual(['exec', '--json', '-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=low', 'codex task']);
    });

    it('kimi: tuning appends -m only (kimi has no effort knob)', async () => {
      const argvOut = join(home, 'argv.json');
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
      process.env.FIXTURE_ARGV_OUT = argvOut;

      await kimiAdapter.dispatch({ task: 'kimi task' }, { timeoutMs: 10_000, tuning: { model: 'kimi-k2.5' } });
      const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
      expect(argv.slice(-2)).toEqual(['-m', 'kimi-k2.5']);
    });

    it('claude: onEvent streams derived tool events live during dispatch', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
      const events: { name: string; summary: string; status: string }[] = [];
      let eventsDoneBeforeResult = false;

      const text = await claudeAdapter.dispatch(
        { task: 't' },
        { timeoutMs: 10_000, onEvent: (e) => events.push(e) },
      );
      eventsDoneBeforeResult = events.length > 0;
      expect(text).toBe('fixture claude answer');
      expect(eventsDoneBeforeResult).toBe(true);
      expect(events).toEqual([
        { name: 'Bash', summary: 'ls -la', status: 'start' },
        { name: 'Bash', summary: 'ls -la', status: 'ok' },
      ]);
    });

    it('codex: onEvent derives start/ok for command_execution, never agent_message', async () => {
      process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
      const events: { name: string; status: string }[] = [];

      const text = await codexAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000, onEvent: (e) => events.push(e) });
      expect(text).toBe('fixture codex answer');
      expect(events).toEqual([
        { name: 'command_execution', summary: 'ls -la', status: 'start' },
        { name: 'command_execution', summary: 'ls -la', status: 'ok' },
      ]);
    });

    it('kimi: onEvent derives events from the verified tool_calls/tool shape', async () => {
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
      const events: { name: string; status: string }[] = [];

      const text = await kimiAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000, onEvent: (e) => events.push(e) });
      expect(text).toBe('fixture kimi answer');
      expect(events).toEqual([
        { name: 'Read', summary: 'package.json', status: 'start' },
        { name: 'Read', summary: 'package.json', status: 'ok' },
      ]);
    });

    it('missing CLI fails honestly with cli-not-found', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = 'definitely-not-a-real-cli-xyz';
      const err = await claudeAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('cli-not-found');
      expect((err as BridgeError).message).toContain('PREVIOUSLY_BRIDGE_CLAUDE_CMD');
    });

    it('non-zero exit surfaces the stderr tail verbatim', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.fail);
      const err = await claudeAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('cli-error');
      expect((err as BridgeError).message).toContain('exited with code 3');
      expect((err as BridgeError).message).toContain('fixture auth error: not logged in');
    });

    it('a hanging CLI is killed and reported as timeout', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.hang);
      const err = await claudeAdapter.dispatch({ task: 't' }, { timeoutMs: 800 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('timeout');
      expect((err as BridgeError).message).toContain('timed out after 800ms');
    });

    it('an aborted dispatch kills the CLI and reports aborted', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.hang);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const err = await claudeAdapter
        .dispatch({ task: 't' }, { timeoutMs: 30_000, signal: controller.signal })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('aborted');
    });

    it('claude error result event (exit 0) is an honest cli-error, never faked success', async () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claudeError);
      const err = await claudeAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('cli-error');
      expect((err as BridgeError).message).toContain('error_max_turns');
    });

    it('codex stream error event (exit 0) surfaces as cli-error', async () => {
      process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codexError);
      const err = await codexAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('cli-error');
      expect((err as BridgeError).message).toContain('quota exhausted');
    });

    it('malformed stream (non-JSON only) fails as empty-result, mentioning the noise', async () => {
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.garbage);
      const err = await kimiAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('empty-result');
      expect((err as BridgeError).message).toContain('non-JSON');
    });

    it('exit 0 with no output at all fails as empty-result', async () => {
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.empty);
      const err = await kimiAdapter.dispatch({ task: 't' }, { timeoutMs: 10_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).reason).toBe('empty-result');
    });
  });

  describe('env resolution helpers', () => {
    it('splitCommand handles quoted segments', () => {
      expect(splitCommand('node "C:\\some dir\\fixture.js" --flag')).toEqual([
        'node',
        'C:\\some dir\\fixture.js',
        '--flag',
      ]);
      expect(splitCommand('claude')).toEqual(['claude']);
    });

    it('resolveTimeoutMs: per-adapter env beats global env beats default', () => {
      expect(resolveTimeoutMs('claude')).toBe(570_000);
      process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS = '5000';
      expect(resolveTimeoutMs('claude')).toBe(5000);
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_TIMEOUT_MS = '1234';
      expect(resolveTimeoutMs('claude')).toBe(1234);
      expect(resolveTimeoutMs('kimi')).toBe(5000);
    });

    it('checkCliPresence: honest found/not-found', () => {
      process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = process.execPath;
      expect(checkCliPresence('claude').found).toBe(true);
      process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = 'definitely-not-a-real-cli-xyz';
      const missing = checkCliPresence('codex');
      expect(missing.found).toBe(false);
      expect(missing.detail).toContain('not on PATH');
      // A path-like override checks the filesystem.
      process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtures.kimi;
      expect(checkCliPresence('kimi').found).toBe(true);
      expect(existsSync(fixtures.kimi)).toBe(true);
    });
  });
});
