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
    delete process.env.PREVIOUSLY_BRIDGE_KIMI_CMD;
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

  it('adapter failure exits 1 with the reason on stderr and nothing on stdout', async () => {
    process.env.PREVIOUSLY_BRIDGE_CLAUDE_CMD = 'definitely-not-a-real-cli-xyz';
    const code = await bridgeExec(['--agent', 'claude'], { stdin: payload('t') });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('[cli-not-found]');
    expect(stdout).toEqual([]);
  });
});
