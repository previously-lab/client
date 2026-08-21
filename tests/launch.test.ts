import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as launch, type LaunchDeps } from '../src/commands/launch.js';
import { resolvePaths } from '../src/lib/paths.js';
import { writePidFile } from '../src/lib/process.js';
import { cleanupTempHome, useTempHome, writeConfigWithPort, getFreePort } from './helpers.js';

function makeDeps(overrides: Partial<LaunchDeps> = {}) {
  const calls = { start: 0, status: 0, opened: [] as string[] };
  const deps: LaunchDeps = {
    isTTY: false,
    startFn: async () => {
      calls.start++;
      return 0;
    },
    statusFn: async () => {
      calls.status++;
      return 0;
    },
    openBrowserFn: (url) => {
      calls.opened.push(url);
      return { ok: true };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('launch state machine (bare `previously`)', () => {
  let home: string;
  let stdout: string[];
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('state 1: honest guidance to `previously init`, exit 1', async () => {
    home = useTempHome();
    const { deps, calls } = makeDeps({ isTTY: false });
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
    expect(await launch([], deps)).toBe(1);
    expect(stderr.join('\n')).toContain('previously init');
    expect(calls.start).toBe(0);
    expect(calls.opened).toEqual([]);
  });

  it('state 1 TTY: same non-interactive guidance, exit 1', async () => {
    home = useTempHome();
    const { deps, calls } = makeDeps({ isTTY: true });
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
    expect(await launch([], deps)).toBe(1);
    expect(stderr.join('\n')).toContain('previously init');
    expect(calls.start).toBe(0);
  });

  it('state 2 TTY: starts, opens the browser, prints a summary, done', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    const { deps, calls } = makeDeps({ isTTY: true });
    expect(await launch([], deps)).toBe(0);
    expect(calls.start).toBe(1);
    expect(calls.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const out = stdout.join('\n');
    expect(out).toContain('Previously is running.');
    expect(out).toContain('Web UI:');
    expect(out).toContain('previously stop');
  });

  it('state 2 non-TTY: starts and reports text, no browser', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    const { deps, calls } = makeDeps({ isTTY: false });
    expect(await launch([], deps)).toBe(0);
    expect(calls.start).toBe(1);
    expect(calls.opened).toEqual([]);
    expect(stdout.join('\n')).toContain('Previously is running at http://127.0.0.1:');
  });

  it('state 2: a start failure propagates honestly (no browser, no summary)', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    const { deps, calls } = makeDeps({ isTTY: true, startFn: async () => 1 });
    expect(await launch([], deps)).toBe(1);
    expect(calls.opened).toEqual([]);
  });

  it('state 3 TTY: running kernel opens the browser and prints a summary', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    writePidFile(resolvePaths().pidPath, process.pid);
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    const { deps, calls } = makeDeps({ isTTY: true });
    expect(await launch([], deps)).toBe(0);
    expect(calls.start).toBe(0);
    expect(calls.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stdout.join('\n')).toContain('Previously is already running.');
  });

  it('state 3 non-TTY: equivalent of `previously status`', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    writePidFile(resolvePaths().pidPath, process.pid);
    const { deps, calls } = makeDeps({ isTTY: false, statusFn: async () => {
      calls.status++;
      return 0;
    } });
    expect(await launch([], deps)).toBe(0);
    expect(calls.status).toBe(1);
    expect(calls.opened).toEqual([]);
  });
});
