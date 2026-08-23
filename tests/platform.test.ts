import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSpawnTarget, runProcess } from '../src/bridge/runner.js';
import { defaultExec } from '../src/lib/kernel.js';
import { saveConfig, defaultConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { assertInside } from '../src/lib/slices.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

/**
 * Platform-behavior tests. Pure logic (resolveSpawnTarget, assertInside) is
 * exercised with injected platforms so it runs everywhere; the spawn/exec
 * end-to-end cases are gated to the platform they exercise — the CI matrix
 * (windows-latest / macos-15 / ubuntu-latest) is what makes the gates real.
 */

describe('resolveSpawnTarget', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('routes a bare name resolving to a .cmd shim through the shell (win32)', () => {
    home = useTempHome();
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'agent.cmd'), '@echo off\r\n', 'utf8');
    const target = resolveSpawnTarget('agent', { platform: 'win32', pathEnv: bin });
    expect(target.shell).toBe(true);
    expect(target.command).toBe(join(bin, 'agent.cmd'));
  });

  it('routes an explicit .cmd path through the shell (win32)', () => {
    const target = resolveSpawnTarget('C:\\tools\\agent.cmd', { platform: 'win32', pathEnv: '' });
    expect(target).toEqual({ command: 'C:\\tools\\agent.cmd', shell: true });
  });

  it('keeps real executables on the direct spawn path (win32)', () => {
    home = useTempHome();
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'agent.exe'), '', 'utf8');
    const target = resolveSpawnTarget('agent', { platform: 'win32', pathEnv: bin });
    expect(target).toEqual({ command: 'agent', shell: false });
  });

  it('passes unknown commands through unchanged (win32)', () => {
    const target = resolveSpawnTarget('agent', { platform: 'win32', pathEnv: '' });
    expect(target).toEqual({ command: 'agent', shell: false });
  });

  it('never uses the shell on POSIX, even for shim-looking names', () => {
    expect(resolveSpawnTarget('agent.cmd', { platform: 'darwin', pathEnv: '' })).toEqual({
      command: 'agent.cmd',
      shell: false,
    });
    expect(resolveSpawnTarget('agent', { platform: 'linux', pathEnv: '' })).toEqual({
      command: 'agent',
      shell: false,
    });
  });
});

describe('windows .cmd shim execution', () => {
  let home: string;
  let savedPath: string | undefined;
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    cleanupTempHome(home);
  });

  const setupShim = (): void => {
    home = useTempHome();
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'previously-test-shim.cmd'), '@echo off\r\necho shim-ran %~1\r\n', 'utf8');
    savedPath = process.env.PATH;
    process.env.PATH = `${bin};${savedPath ?? ''}`;
  };

  it.runIf(process.platform === 'win32')('runProcess executes a bare-name .cmd shim', async () => {
    setupShim();
    const outcome = await runProcess('previously-test-shim', ['hello'], { timeoutMs: 10_000 });
    expect(outcome.spawnError).toBeNull();
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('shim-ran hello');
  });

  it.runIf(process.platform === 'win32')('defaultExec falls back to cmd.exe for .cmd shims', () => {
    setupShim();
    const res = defaultExec('previously-test-shim', ['world']);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('shim-ran world');
  });
});

describe('saveConfig permissions', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it.runIf(process.platform !== 'win32')('config.json is owner-only (0600) — it holds API keys', () => {
    home = useTempHome();
    const paths = resolvePaths();
    saveConfig(defaultConfig(paths), paths);
    expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);

    // A pre-existing world-readable file is tightened on the next save.
    writeFileSync(paths.configPath, '{}\n', { encoding: 'utf8', mode: 0o644 });
    saveConfig(defaultConfig(paths), paths);
    expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
  });
});

describe('assertInside case handling', () => {
  it.runIf(process.platform === 'win32')('accepts a drive-letter case mismatch on Windows', () => {
    const inner = assertInside('c:\\previously-root', 'C:\\previously-root\\sub\\file.md');
    expect(inner.toLowerCase()).toContain('c:\\previously-root\\sub');
  });

  it('still rejects escapes', () => {
    expect(() => assertInside('/tmp/root', '/tmp/root/../elsewhere')).toThrow(/escapes/);
  });
});
