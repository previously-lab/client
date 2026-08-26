import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as bridgeExec } from '../src/commands/bridge-exec.js';
import { defaultConfig, saveConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, writeFixtureClis, type FixtureClis } from './bridge-fixtures.js';

const payload = (task: string, context: string | null = null): string =>
  JSON.stringify({ task, context });

describe('bridge-exec command', () => {
  let home: string;
  let fixtures: FixtureClis;
  let stdout: string[];
  let stderr: string[];
  let writes: string[];

  beforeEach(() => {
    home = useTempHome();
    fixtures = writeFixtureClis(join(home, 'fixtures'));
    stdout = [];
    stderr = [];
    writes = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD;
    delete process.env.PREVIOUSLY_BRIDGE_KIMI_CMD;
    delete process.env.PREVIOUSLY_BRIDGE_CODEX_CMD;
    delete process.env.PREVIOUSLY_BRAIN_AGENT;
    delete process.env.FIXTURE_CWD_OUT;
    cleanupTempHome(home);
  });

  it('malformed stdin JSON exits 2 with an actionable message', async () => {
    const code = await bridgeExec(['--agent', 'claude'], { stdin: 'not json{{' });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('not valid JSON');
    expect(stdout).toEqual([]);
  });

  it('payload without a task exits 2', async () => {
    const code = await bridgeExec(['--agent', 'claude'], { stdin: JSON.stringify({ context: 'x' }) });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('"task"');
  });

  it('non-string context exits 2', async () => {
    const code = await bridgeExec(['--agent', 'claude'], { stdin: JSON.stringify({ task: 't', context: 42 }) });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('"context" must be a string or null');
  });

  it('unknown --agent exits 2', async () => {
    const code = await bridgeExec(['--agent', 'gemini'], { stdin: payload('t') });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Unknown --agent value: gemini');
  });

  it('no --agent and no configured backend exits 2 with guidance', async () => {
    saveConfig(defaultConfig(resolvePaths()), resolvePaths());
    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('No bridge agent selected');
  });

  it('executionBackend=api-key is not a bridge CLI — exits 2 honestly', async () => {
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'api-key' }, paths);
    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('"api-key"');
  });

  it('success: config backend routes to the adapter, result text on stdout, exit 0', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'claude' }, paths);

    const code = await bridgeExec([], { stdin: payload('write a haiku', 'some context') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture claude answer');
    expect(stderr).toEqual([]);
  });

  it('--agent overrides the configured backend', async () => {
    process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'claude' }, paths);

    const code = await bridgeExec(['--agent', 'kimi'], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture kimi answer');
  });

  it('PREVIOUSLY_BRAIN_AGENT env picks the agent (kernel per-spawn override)', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    process.env.PREVIOUSLY_BRAIN_AGENT = 'claude';
    saveConfig(defaultConfig(resolvePaths()), resolvePaths()); // executionBackend unset

    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture claude answer');
  });

  it('PREVIOUSLY_BRAIN_AGENT env wins over config executionBackend', async () => {
    process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
    process.env.PREVIOUSLY_BRAIN_AGENT = 'kimi';
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'claude' }, paths);

    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture kimi answer');
  });

  it('--agent wins over PREVIOUSLY_BRAIN_AGENT', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    process.env.PREVIOUSLY_BRAIN_AGENT = 'kimi';

    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture claude answer');
  });

  it('an unknown PREVIOUSLY_BRAIN_AGENT exits 2 honestly', async () => {
    process.env.PREVIOUSLY_BRAIN_AGENT = 'gemini';
    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Unknown PREVIOUSLY_BRAIN_AGENT value: gemini');
  });

  it('adapter failure exits 1 with the reason on stderr and nothing on stdout', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = 'definitely-not-a-real-cli-xyz';
    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[cli-not-found]');
    expect(stdout).toEqual([]);
  });

  it('spawns claude in a temp workspace carrying CLAUDE.md with MEMORY_ROOT, cleaned up after', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    const cwdOut = join(home, 'cwd.json');
    process.env.FIXTURE_CWD_OUT = cwdOut;
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'claude' }, paths);

    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(0);

    const rec = JSON.parse(readFileSync(cwdOut, 'utf8')) as {
      cwd: string;
      claudeMd: string | null;
      agentsMd: string | null;
    };
    // The CLI ran in a per-call temp dir, not our cwd.
    expect(rec.cwd).not.toBe(process.cwd());
    // The workspace carried the memory skill document with MEMORY_ROOT filled.
    expect(rec.claudeMd).not.toBeNull();
    expect(rec.claudeMd).toContain('Previously Memory');
    expect(rec.claudeMd).toContain(paths.memoryDir);
    expect(rec.claudeMd).not.toContain('{{MEMORY_ROOT}}');
    expect(rec.agentsMd).toBeNull();
    // The workspace is removed after the call.
    expect(existsSync(rec.cwd)).toBe(false);
  });

  it('codex gets AGENTS.md in its workspace (same document, per-agent filename)', async () => {
    process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
    const cwdOut = join(home, 'cwd.json');
    process.env.FIXTURE_CWD_OUT = cwdOut;
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'codex' }, paths);

    const code = await bridgeExec([], { stdin: payload('t') });
    expect(code).toBe(0);

    const rec = JSON.parse(readFileSync(cwdOut, 'utf8')) as {
      cwd: string;
      claudeMd: string | null;
      agentsMd: string | null;
    };
    expect(rec.agentsMd).not.toBeNull();
    expect(rec.agentsMd).toContain(paths.memoryDir);
    expect(rec.claudeMd).toBeNull();
    expect(existsSync(rec.cwd)).toBe(false);
  });
});

describe('bridge-exec protocol 2 (NDJSON event envelope)', () => {
  let home: string;
  let fixtures: FixtureClis;
  let stdout: string[];
  let stderr: string[];
  let writes: string[];

  beforeEach(() => {
    home = useTempHome();
    fixtures = writeFixtureClis(join(home, 'fixtures'));
    stdout = [];
    stderr = [];
    writes = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD;
    delete process.env.PREVIOUSLY_BRIDGE_KIMI_CMD;
    delete process.env.PREVIOUSLY_BRIDGE_CODEX_CMD;
    delete process.env.FIXTURE_ARGV_OUT;
    cleanupTempHome(home);
  });

  const ndjsonLines = (): Record<string, unknown>[] =>
    writes
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('streams {"event"} lines live, then a final {"protocol":2,result,events} envelope', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);

    const code = await bridgeExec(['--agent', 'claude'], {
      stdin: JSON.stringify({ task: 't', context: null, protocol: 2 }),
    });
    expect(code).toBe(0);
    // Result does NOT go through the legacy console.log path.
    expect(stdout).toEqual([]);

    const lines = ndjsonLines();
    expect(lines).toHaveLength(3);
    const streamed = lines.slice(0, -1).map((l) => l.event);
    expect(streamed).toEqual([
      { name: 'Bash', summary: 'ls -la', status: 'start' },
      { name: 'Bash', summary: 'ls -la', status: 'ok' },
    ]);
    const envelope = lines[lines.length - 1]!;
    expect(envelope.protocol).toBe(2);
    expect(envelope.result).toBe('fixture claude answer');
    // The envelope's events array is exactly what was streamed live.
    expect(envelope.events).toEqual(streamed);
  });

  it('claude streams {"delta"} lines live before the unchanged final envelope', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claudeDeltas);

    const code = await bridgeExec(['--agent', 'claude'], {
      stdin: JSON.stringify({ task: 't', context: null, protocol: 2 }),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);

    const lines = ndjsonLines();
    // Live lines: deltas and tool events interleaved, in stream order.
    expect(lines.slice(0, -1)).toEqual([
      { delta: 'fixture ' },
      { event: { name: 'Bash', summary: 'ls -la', status: 'start' } },
      { event: { name: 'Bash', summary: 'ls -la', status: 'ok' } },
      { delta: 'claude delta ' },
      { delta: 'answer' },
    ]);
    // The final envelope is unchanged: source of truth, no deltas recorded.
    const envelope = lines[lines.length - 1]!;
    expect(envelope).toEqual({
      protocol: 2,
      result: 'fixture claude delta answer',
      events: [
        { name: 'Bash', summary: 'ls -la', status: 'start' },
        { name: 'Bash', summary: 'ls -la', status: 'ok' },
      ],
    });
  });

  it('codex and kimi emit no delta lines under protocol 2', async () => {
    process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
    const code = await bridgeExec(['--agent', 'codex'], {
      stdin: JSON.stringify({ task: 't', protocol: 2 }),
    });
    expect(code).toBe(0);
    expect(ndjsonLines().every((l) => !('delta' in l))).toBe(true);
  });

  it('legacy protocol (absent) never emits delta lines even from a delta-capable CLI', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claudeDeltas);

    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture claude delta answer');
    // No NDJSON lines were written at all — stdout stays raw result text.
    expect(writes.join('')).toBe('');
  });

  it('codex and kimi emit their derived events under protocol 2', async () => {
    process.env.PREVIOUSLY_BRIDGE_CODEX_CMD = fixtureCmd(fixtures.codex);
    const code = await bridgeExec(['--agent', 'codex'], {
      stdin: JSON.stringify({ task: 't', protocol: 2 }),
    });
    expect(code).toBe(0);
    let lines = ndjsonLines();
    expect(lines.slice(0, -1).map((l) => l.event)).toEqual([
      { name: 'command_execution', summary: 'ls -la', status: 'start' },
      { name: 'command_execution', summary: 'ls -la', status: 'ok' },
    ]);
    expect(lines[lines.length - 1]!.result).toBe('fixture codex answer');

    writes = [];
    process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(fixtures.kimi);
    const code2 = await bridgeExec(['--agent', 'kimi'], {
      stdin: JSON.stringify({ task: 't', protocol: 2 }),
    });
    expect(code2).toBe(0);
    lines = ndjsonLines();
    expect(lines.slice(0, -1).map((l) => l.event)).toEqual([
      { name: 'Read', summary: 'package.json', status: 'start' },
      { name: 'Read', summary: 'package.json', status: 'ok' },
    ]);
    expect(lines[lines.length - 1]!.result).toBe('fixture kimi answer');
  });

  it('a stream without tool events degrades honestly to an empty events array', async () => {
    const noTools = join(home, 'fixtures', 'fixture-kimi-no-tools.js');
    writeFileSync(
      noTools,
      `const lines = [
        JSON.stringify({ role: 'meta', type: 'system.version', version: '0' }),
        JSON.stringify({ role: 'assistant', content: 'plain kimi answer' }),
      ];
      process.stdout.write(lines.join('\\n') + '\\n');
      `,
      'utf8',
    );
    process.env.PREVIOUSLY_BRIDGE_KIMI_CMD = fixtureCmd(noTools);

    const code = await bridgeExec(['--agent', 'kimi'], {
      stdin: JSON.stringify({ task: 't', protocol: 2 }),
    });
    expect(code).toBe(0);
    const lines = ndjsonLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ protocol: 2, result: 'plain kimi answer', events: [] });
  });

  it('event cap: drops the tail and appends a synthetic omission note', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claudeManyEvents);

    const code = await bridgeExec(['--agent', 'claude'], {
      stdin: JSON.stringify({ task: 't', protocol: 2 }),
    });
    expect(code).toBe(0);
    const lines = ndjsonLines();
    // 100 live event lines (cap), then the final envelope.
    expect(lines).toHaveLength(101);
    expect(lines.slice(0, -1).every((l) => 'event' in l)).toBe(true);
    const envelope = lines[lines.length - 1]!;
    const events = envelope.events as { name: string; summary: string; status: string }[];
    expect(events).toHaveLength(101);
    const note = events[events.length - 1]!;
    expect(note.name).toBe('bridge');
    expect(note.summary).toContain('50 more tool events omitted');
  });

  it('an unsupported protocol value exits 2', async () => {
    const code = await bridgeExec(['--agent', 'claude'], {
      stdin: JSON.stringify({ task: 't', protocol: 3 }),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('"protocol" must be 2');
  });

  it('legacy protocol (absent) stays raw text — old kernel compat', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);

    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toBe('fixture claude answer');
    // No NDJSON envelope lines were written.
    expect(writes.join('')).toBe('');
  });

  it('config agents tuning reaches the adapter argv', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    const argvOut = join(home, 'argv.json');
    process.env.FIXTURE_ARGV_OUT = argvOut;
    const paths = resolvePaths();
    saveConfig(
      { ...defaultConfig(paths), agents: { claude: { model: 'claude-opus-4-8', effort: 'medium' } } },
      paths,
    );

    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(0);
    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv.slice(-4)).toEqual(['--model', 'claude-opus-4-8', '--effort', 'medium']);
  });
});

describe('bridge-exec phase outsourcing (phase payload field)', () => {
  let home: string;
  let fixtures: FixtureClis;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = useTempHome();
    fixtures = writeFixtureClis(join(home, 'fixtures'));
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD;
    delete process.env.FIXTURE_CWD_OUT;
    delete process.env.FIXTURE_ENV_OUT;
    delete process.env.PREVIOUSLY_READER_SCOPE;
    cleanupTempHome(home);
  });

  const runWithWorkspace = async (
    stdin: string,
  ): Promise<{ claudeMd: string | null; skills: Record<string, string> | null; readerScope: string }> => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = fixtureCmd(fixtures.claude);
    const cwdOut = join(home, 'cwd.json');
    const envOut = join(home, 'env.txt');
    process.env.FIXTURE_CWD_OUT = cwdOut;
    process.env.FIXTURE_ENV_OUT = envOut;
    const paths = resolvePaths();
    saveConfig({ ...defaultConfig(paths), executionBackend: 'claude' }, paths);

    const code = await bridgeExec([], { stdin });
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(cwdOut, 'utf8')) as {
      claudeMd: string | null;
      skills: Record<string, string> | null;
    };
    return { ...rec, readerScope: readFileSync(envOut, 'utf8') };
  };

  it("phase 'chat' carries the chat doc (constrained reader-tool contract), not the generic doc", async () => {
    const rec = await runWithWorkspace(JSON.stringify({ task: 't', context: null, phase: 'chat' }));
    expect(rec.claudeMd).not.toBeNull();
    // The doc renders the {{PREVIOUSLY_CMD}} placeholder with the bare
    // registered command name (`previously readslice ...`) — the spawned
    // agent invokes reader commands through its own shell, which resolves
    // the global shim exactly like a user typing it would.
    expect(rec.claudeMd).toContain('previously readslice <sliceId>');
    expect(rec.claudeMd).not.toContain('recall "<query>"');
    expect(rec.claudeMd).not.toContain('{{PREVIOUSLY_CMD}}');
    expect(rec.claudeMd).toContain('rendered verbatim in a web chat UI');
    expect(rec.claudeMd).not.toContain('# Previously Memory (read-only)');
    expect(rec.claudeMd).not.toContain('{{MEMORY_ROOT}}');
  });

  it("phase 'housekeeping' carries the thin housekeeping doc (rules defer to the task input)", async () => {
    const rec = await runWithWorkspace(JSON.stringify({ task: 't', context: null, phase: 'housekeeping' }));
    expect(rec.claudeMd).not.toBeNull();
    expect(rec.claudeMd).toContain('task input');
    expect(rec.claudeMd).toContain('NEVER write anything anywhere under the memory root');
    // The mutation vocabulary / output schema moved to the kernel task text.
    expect(rec.claudeMd).not.toContain('CardMutation');
    expect(rec.claudeMd).not.toContain('EXACTLY one JSON object');
    expect(rec.claudeMd).not.toContain('# Previously Memory (read-only)');
    expect(rec.claudeMd).not.toContain('{{MEMORY_ROOT}}');
    expect(rec.claudeMd).not.toContain('{{PREVIOUSLY_CMD}}');
  });

  it('absent phase keeps the generic memory doc (legacy delegateTask path)', async () => {
    const paths = resolvePaths();
    const rec = await runWithWorkspace(payload('t'));
    expect(rec.claudeMd).toContain('Previously Memory');
    expect(rec.claudeMd).toContain(paths.memoryDir);
  });

  it('the spawned agent inherits PREVIOUSLY_READER_SCOPE matching the phase (reader gate)', async () => {
    const chat = await runWithWorkspace(JSON.stringify({ task: 't', context: null, phase: 'chat' }));
    expect(chat.readerScope).toBe('chat');

    const hk = await runWithWorkspace(JSON.stringify({ task: 't', context: null, phase: 'housekeeping' }));
    expect(hk.readerScope).toBe('housekeeping');

    // Legacy path: no phase, no scope — the reader gate stays off.
    const legacy = await runWithWorkspace(payload('t'));
    expect(legacy.readerScope).toBe('');

    // The gate env never leaks past the bridge-exec call itself.
    expect(process.env.PREVIOUSLY_READER_SCOPE).toBeUndefined();
  });

  it('payload skills are materialized as skills/<name>.md with placeholders filled', async () => {
    const paths = resolvePaths();
    const rec = await runWithWorkspace(
      JSON.stringify({
        task: 't',
        context: null,
        phase: 'chat',
        skills: {
          recall:
            '# Recall\n\nSearch with `{{PREVIOUSLY_CMD}} timeline` under {{MEMORY_ROOT}}; report pointers only.\n',
        },
      }),
    );
    expect(rec.skills).not.toBeNull();
    const recallSkill = rec.skills!['recall.md'];
    expect(recallSkill).toBeDefined();
    expect(recallSkill).not.toContain('{{PREVIOUSLY_CMD}}');
    expect(recallSkill).not.toContain('{{MEMORY_ROOT}}');
    expect(recallSkill).toContain('previously timeline');
    expect(recallSkill).toContain(paths.memoryDir);
  });

  it('no skills key → no skills directory in the workspace', async () => {
    const rec = await runWithWorkspace(JSON.stringify({ task: 't', context: null, phase: 'chat' }));
    expect(rec.skills).toBeNull();
  });

  it('a malformed skills value exits 2', async () => {
    for (const skills of [42, 'x', [1], { recall: 42 }]) {
      const code = await bridgeExec(['--agent', 'claude'], {
        stdin: JSON.stringify({ task: 't', skills }),
      });
      expect(code).toBe(2);
      expect(stderr.join('\n')).toContain('"skills');
      stderr = [];
    }
    expect(stdout).toEqual([]);
  });

  it('an invalid phase value exits 2', async () => {
    const code = await bridgeExec(['--agent', 'claude'], {
      stdin: JSON.stringify({ task: 't', phase: 'deep-think' }),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('"phase" must be one of chat|housekeeping');
    expect(stdout).toEqual([]);
  });
});
