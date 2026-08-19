import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScribe } from '../src/commands/scribe.js';
import { run as start } from '../src/commands/start.js';
import { run as status } from '../src/commands/status.js';
import { run as stop } from '../src/commands/stop.js';
import { resolvePaths } from '../src/lib/paths.js';
import { isProcessAlive, readPidFile } from '../src/lib/process.js';
import type { ScribeRoots } from '../src/scribe/types.js';
import {
  cleanupTempHome,
  getFreePort,
  useTempHome,
  writeConfigWithPort,
  writeFixtureKernel,
} from './helpers.js';
import {
  claudeUserLine,
  codexMessageLine,
  codexSessionMetaLine,
  makeFakeAgentHome,
  writeClaudeSession,
  writeCodexSession,
} from './scribe-fixtures.js';

describe('scribe commands', () => {
  let home: string;
  let roots: ScribeRoots;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = useTempHome();
    roots = makeFakeAgentHome(join(home, 'fakehome'));
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop([], { graceTimeoutMs: 2_000 });
    cleanupTempHome(home);
  });

  function writeBothSessions(): void {
    writeClaudeSession(roots, 'sess-a', [
      claudeUserLine('命令行测试', '2026-08-10T14:01:00.000Z', 'sess-a'),
    ]);
    writeCodexSession(roots, 'r1', [
      codexSessionMetaLine('rollout-1', '2026-08-10T15:30:00.000Z'),
      codexMessageLine('user', '你好 codex', '2026-08-10T15:30:02.000Z'),
    ]);
  }

  it('scribe once scans both sources and reports per-source counts', async () => {
    writeBothSessions();
    const code = await runScribe(['once'], { roots });
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('claude-code: 1/1 files, 1 events');
    expect(out).toContain('codex: 1/1 files, 1 events');
    expect(existsSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1530', 'timeline', 'core.md'))).toBe(true);
  });

  it('scribe once --source limits the scan', async () => {
    writeBothSessions();
    const code = await runScribe(['once', '--source', 'codex'], { roots });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('codex: 1/1 files');
    expect(stdout.join('\n')).not.toContain('claude-code: 1/1');
    expect(existsSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1530', 'timeline', 'core.md'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md'))).toBe(false);
  });

  it('rejects unknown subcommands and bad --source values', async () => {
    expect(await runScribe(['bogus'], { roots })).toBe(1);
    expect(await runScribe(['once', '--source', 'gemini'], { roots })).toBe(1);
  });

  it('status reports the scribe section after a scan', async () => {
    writeBothSessions();
    await runScribe(['once'], { roots });
    stdout = [];
    const code = await status([]);
    expect(out()).toContain('Scribe:');
    expect(out()).toContain('claude-code: 1/1 files, 1 events, 0 parse errors');
    expect(out()).toContain('codex: 1/1 files, 1 events, 0 parse errors');
    // Kernel isn't running → non-zero exit, scribe info still shown.
    expect(code).toBe(1);

    function out(): string {
      return stdout.join('\n');
    }
  });

  it('status reports absent roots honestly', async () => {
    await runScribe(['once'], { roots });
    stdout = [];
    await status([]);
    expect(stdout.join('\n')).toContain('claude-code: root absent');
    expect(stdout.join('\n')).toContain('codex: root absent');
  });

  it('start auto-spawns the scribe; stop stops both processes', async () => {
    writeFixtureKernel(home);
    const port = await getFreePort();
    writeConfigWithPort(port);
    // A stand-in scribe entry: stays alive like the real `watch` process.
    const scribeEntry = join(home, 'fixture-scribe.js');
    writeFileSync(scribeEntry, 'setInterval(() => {}, 1000);\n', 'utf8');

    const code = await start([], { healthTimeoutMs: 15_000, scribeEntry });
    expect(code).toBe(0);

    const paths = resolvePaths();
    const kernelPid = readPidFile(paths.pidPath);
    const scribePid = readPidFile(paths.scribePidPath);
    expect(kernelPid).not.toBeNull();
    expect(scribePid).not.toBeNull();
    expect(isProcessAlive(kernelPid!)).toBe(true);
    expect(isProcessAlive(scribePid!)).toBe(true);
    expect(stdout.join('\n')).toContain('Scribe is running');

    expect(await stop([], { graceTimeoutMs: 3_000 })).toBe(0);
    expect(existsSync(paths.pidPath)).toBe(false);
    expect(existsSync(paths.scribePidPath)).toBe(false);
    expect(isProcessAlive(kernelPid!)).toBe(false);
    expect(isProcessAlive(scribePid!)).toBe(false);
  });

  it('start warns but still succeeds when the scribe entry is broken', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(await getFreePort());
    const code = await start([], {
      healthTimeoutMs: 15_000,
      scribeEntry: join(home, 'does-not-exist.js'),
    });
    // node exits asynchronously for a missing entry; the spawn itself either
    // throws (warned) or the pid dies quickly — either way start succeeds.
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Previously kernel is running');
  });

  it('start does not double-spawn a live scribe', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(await getFreePort());
    const scribeEntry = join(home, 'fixture-scribe.js');
    writeFileSync(scribeEntry, 'setInterval(() => {}, 1000);\n', 'utf8');

    expect(await start([], { healthTimeoutMs: 15_000, scribeEntry })).toBe(0);
    const firstPid = readPidFile(resolvePaths().scribePidPath);
    await stop([], { graceTimeoutMs: 3_000 });

    // Kernel down, scribe still pinned alive by its pid file → start must not
    // spawn a second one. (Simulated by keeping the fixture alive.)
    const { spawn } = await import('node:child_process');
    const impostor = spawn(process.execPath, [scribeEntry], { detached: true, stdio: 'ignore' });
    impostor.unref();
    const { writePidFile } = await import('../src/lib/process.js');
    writePidFile(resolvePaths().scribePidPath, impostor.pid!);
    try {
      expect(await start([], { healthTimeoutMs: 15_000, scribeEntry })).toBe(0);
      expect(stdout.join('\n')).toContain('Scribe is already running');
      expect(readPidFile(resolvePaths().scribePidPath)).toBe(impostor.pid);
    } finally {
      await stop([], { graceTimeoutMs: 3_000 });
    }
  });
});
