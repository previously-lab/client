import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { fixtureCmd, writeFixtureClis, type FixtureClis } from './bridge-fixtures.js';

/**
 * End-to-end proof of the kernel ↔ client bridge contract (design §7, batch
 * C4): spawn the real built `dist/cli.js bridge-exec` exactly the way the
 * kernel's delegateTask executor spawns PREVIOUSLY_BRIDGE_CMD — JSON payload
 * on stdin, raw result text on stdout, exit code as the success signal.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');

function runBridgeExec(
  args: string[],
  input: string,
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, 'bridge-exec', ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('bridge-exec e2e (real dist/cli.js, fixture CLIs)', () => {
  let home: string;
  let fixtures: FixtureClis;

  beforeAll(() => {
    if (!existsSync(cliPath)) {
      const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
      const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (build.status !== 0) {
        throw new Error(`e2e requires a built dist/cli.js; tsc failed:\n${build.stderr}`);
      }
    }
  }, 120_000);

  beforeEach(() => {
    home = useTempHome();
    fixtures = writeFixtureClis(join(home, 'fixtures'));
  });
  afterEach(() => cleanupTempHome(home));

  it('claude: stdin JSON → adapter → raw result text on stdout, exit 0, clean stderr', () => {
    const res = runBridgeExec(
      ['--agent', 'claude'],
      JSON.stringify({ task: 'write a haiku', context: null }),
      { PREVIOUSLY_HOME: home, PREVIOUSLY_BRIDGE_CLAUDE_CMD: fixtureCmd(fixtures.claude) },
    );
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout.trimEnd()).toBe('fixture claude answer');
    expect(res.stderr).toBe('');
  });

  it('the kernel payload shape {task, context} is transported into the CLI prompt', () => {
    const stdinCapture = join(home, 'stdin.txt');
    const res = runBridgeExec(
      ['--agent', 'claude'],
      JSON.stringify({ task: 'THE TASK BODY', context: 'THE CONTEXT BODY' }),
      {
        PREVIOUSLY_HOME: home,
        PREVIOUSLY_BRIDGE_CLAUDE_CMD: fixtureCmd(fixtures.claude),
        FIXTURE_STDIN_OUT: stdinCapture,
      },
    );
    expect(res.status).toBe(0);
    const prompt = readFileSync(stdinCapture, 'utf8');
    expect(prompt).toContain('THE TASK BODY');
    expect(prompt).toContain('THE CONTEXT BODY');
  });

  it('kimi: --agent selection reaches the matching adapter end-to-end', () => {
    const res = runBridgeExec(['--agent', 'kimi'], JSON.stringify({ task: 't', context: null }), {
      PREVIOUSLY_HOME: home,
      PREVIOUSLY_BRIDGE_KIMI_CMD: fixtureCmd(fixtures.kimi),
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trimEnd()).toBe('fixture kimi answer');
  });

  it('CLI failure: non-zero exit, diagnostic on stderr, nothing on stdout', () => {
    const res = runBridgeExec(['--agent', 'claude'], JSON.stringify({ task: 't', context: null }), {
      PREVIOUSLY_HOME: home,
      PREVIOUSLY_BRIDGE_CLAUDE_CMD: fixtureCmd(fixtures.fail),
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('fixture auth error: not logged in');
  });

  it('timeout: hanging CLI is killed, non-zero exit with an honest stderr reason', () => {
    const res = runBridgeExec(['--agent', 'claude'], JSON.stringify({ task: 't', context: null }), {
      PREVIOUSLY_HOME: home,
      PREVIOUSLY_BRIDGE_CLAUDE_CMD: fixtureCmd(fixtures.hang),
      PREVIOUSLY_BRIDGE_CLAUDE_TIMEOUT_MS: '800',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[timeout]');
    // Never the kernel's "empty stdout on exit 0" malformed case.
    expect(res.stdout).toBe('');
  });

  it('malformed stream: exit 0 is never returned without a result on stdout', () => {
    const res = runBridgeExec(['--agent', 'kimi'], JSON.stringify({ task: 't', context: null }), {
      PREVIOUSLY_HOME: home,
      PREVIOUSLY_BRIDGE_KIMI_CMD: fixtureCmd(fixtures.garbage),
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('[empty-result]');
  });

  it('malformed stdin payload exits non-zero with a parse diagnostic', () => {
    const res = runBridgeExec(['--agent', 'claude'], '{broken', {
      PREVIOUSLY_HOME: home,
      PREVIOUSLY_BRIDGE_CLAUDE_CMD: fixtureCmd(fixtures.claude),
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('not valid JSON');
  });
});
