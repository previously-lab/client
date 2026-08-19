import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as logs } from '../src/commands/logs.js';
import { run as start } from '../src/commands/start.js';
import { run as status } from '../src/commands/status.js';
import { run as stop } from '../src/commands/stop.js';
import { resolvePaths } from '../src/lib/paths.js';
import { isProcessAlive, readPidFile, writePidFile } from '../src/lib/process.js';
import {
  cleanupTempHome,
  getDeadPid,
  getFreePort,
  useTempHome,
  writeConfigWithPort,
  writeFixtureKernel,
} from './helpers.js';

/**
 * End-to-end tests against a fixture kernel: a stub node HTTP server written
 * into <PREVIOUSLY_HOME>/kernel/server.js, started/stopped exactly the way
 * the real standalone artifact will be.
 */
describe('kernel lifecycle', () => {
  let home: string;
  let port: number;
  let stderr: string[];
  let stdout: string[];

  beforeEach(async () => {
    home = useTempHome();
    port = await getFreePort();
    stderr = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Belt and braces: never leak a fixture kernel between tests.
    await stop([], { graceTimeoutMs: 3_000 });
    cleanupTempHome(home);
  });

  it('start fails honestly when the kernel artifact is missing', async () => {
    writeConfigWithPort(port);
    const code = await start([], { healthTimeoutMs: 5_000, startScribe: false });
    expect(code).toBe(1);
    const message = stderr.join('\n');
    expect(message).toContain('Kernel artifact not found');
    expect(message).toContain('server.js');
    expect(message).toContain(resolvePaths().kernelDir);
    // No pid file, no process left behind.
    expect(existsSync(resolvePaths().pidPath)).toBe(false);
  });

  it('start fails when the port is already in use', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);
    const blocker = http.createServer((_req, res) => res.end('busy'));
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      const code = await start([], { healthTimeoutMs: 5_000, startScribe: false });
      expect(code).toBe(1);
      expect(stderr.join('\n')).toContain('already in use');
      expect(existsSync(resolvePaths().pidPath)).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('start → status → logs → stop runs the fixture kernel end to end', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);
    // A healthy `start`ed system includes the scribe; status exits non-zero
    // without it, so this test runs a stand-in scribe entry like the real one.
    const scribeEntry = join(home, 'fixture-scribe.js');
    writeFileSync(scribeEntry, 'setInterval(() => {}, 1000);\n', 'utf8');

    expect(await start([], { healthTimeoutMs: 15_000, scribeEntry })).toBe(0);
    const pid = readPidFile(resolvePaths().pidPath);
    expect(pid).not.toBeNull();
    expect(isProcessAlive(pid!)).toBe(true);

    // The kernel answers HTTP.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture kernel');

    expect(await status([])).toBe(0);
    expect(stdout.join('\n')).toContain('running');

    expect(await logs([])).toBe(0);

    expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
    expect(readPidFile(resolvePaths().pidPath)).toBeNull();
    expect(isProcessAlive(pid!)).toBe(false);

    stdout = [];
    expect(await status([])).toBe(1);
    expect(stdout.join('\n')).toContain('not running');
  });

  it('status exits 1 when the kernel runs but the scribe is dead (worst subsystem)', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);

    expect(await start([], { healthTimeoutMs: 15_000, startScribe: false })).toBe(0);
    stdout = [];
    expect(await status([])).toBe(1);
    expect(stdout.join('\n')).toContain('Scribe:    not running');
    expect(stderr.join('\n')).toContain('degraded');

    expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
  });

  it('start removes a stale pid file and proceeds', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);
    writePidFile(resolvePaths().pidPath, getDeadPid());

    expect(await start([], { healthTimeoutMs: 15_000, startScribe: false })).toBe(0);
    const pid = readPidFile(resolvePaths().pidPath);
    expect(pid).not.toBeNull();
    expect(isProcessAlive(pid!)).toBe(true);
    expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
  });

  it('stop handles a stale pid file gracefully', async () => {
    writePidFile(resolvePaths().pidPath, getDeadPid());
    expect(await stop([], { graceTimeoutMs: 1_000 })).toBe(0);
    expect(existsSync(resolvePaths().pidPath)).toBe(false);
    expect(stdout.join('\n')).toContain('stale pid file');
  });

  it('stop with no pid file is a no-op', async () => {
    expect(await stop([])).toBe(0);
    expect(stdout.join('\n')).toContain('not running');
  });

  it('status reports a stale pid file and exits 1', async () => {
    writeConfigWithPort(port);
    writePidFile(resolvePaths().pidPath, getDeadPid());
    expect(await status([])).toBe(1);
    expect(stdout.join('\n')).toContain('stale pid file');
  });

  it('logs fails honestly when no log file exists', async () => {
    expect(await logs([])).toBe(1);
    expect(stderr.join('\n')).toContain('No kernel log');
  });

  it('logs tails the kernel log file', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);
    expect(await start([], { healthTimeoutMs: 15_000, startScribe: false })).toBe(0);
    try {
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      expect(await logs([])).toBe(0);
      expect(out.join('')).toContain('fixture kernel listening');
    } finally {
      expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
    }
  });

  it('second start while running refuses with exit 1', async () => {
    writeFixtureKernel(home);
    writeConfigWithPort(port);
    expect(await start([], { healthTimeoutMs: 15_000, startScribe: false })).toBe(0);
    try {
      expect(await start([], { healthTimeoutMs: 5_000, startScribe: false })).toBe(1);
      expect(stderr.join('\n')).toContain('already running');
    } finally {
      expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
    }
  });
});
