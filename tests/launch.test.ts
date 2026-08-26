import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as launch, type LaunchDeps } from '../src/commands/launch.js';
import { loadConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import type { SystemStatus } from '../src/lib/system-status.js';
import { cleanupTempHome, useTempHome, writeConfigWithPort } from './helpers.js';

/**
 * Launch tests never touch the real machine: initFn/statusFn/statusCollector
 * are fakes, so no init flow runs, no status command executes, and no port is
 * ever probed (the real collectStatus would call isPortOpen with a 1.5s
 * timeout).
 */

/** A plausible SystemStatus for the dashboard; override per test. */
function fakeStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  const paths = resolvePaths();
  return {
    paths,
    config: loadConfig(paths),
    initialized: true,
    kernelPid: process.pid,
    kernelAlive: true,
    reachable: true,
    kernelVersion: null,
    kernelSource: 'default',
    kernelDir: paths.kernelDir,
    compat: null,
    scribePid: process.pid,
    scribeAlive: true,
    scribeStatus: null,
    bridges: [{ agent: 'claude', found: false, detail: 'not on PATH' }],
    today: { sliceCount: 0, lastEventAt: null },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<LaunchDeps> = {}) {
  const initFn = vi.fn(async () => 0);
  const statusFn = vi.fn(async () => 0);
  const statusCollector = vi.fn(async () => fakeStatus());
  const deps: LaunchDeps = { isTTY: false, initFn, statusFn, statusCollector, ...overrides };
  return { deps, initFn, statusFn, statusCollector };
}

describe('launch dispatcher (bare `previously`)', () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  function captureConsole(): void {
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('uninitialized: hands over to initFn and passes its exit code through', async () => {
    home = useTempHome();
    captureConsole();
    const { deps, initFn, statusFn, statusCollector } = makeDeps({ isTTY: false });
    expect(await launch([], deps)).toBe(0);
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(initFn).toHaveBeenCalledWith([], { isTTY: false });
    expect(statusFn).not.toHaveBeenCalled();
    expect(statusCollector).not.toHaveBeenCalled();
  });

  it('uninitialized: an init failure propagates, with no "run init first" nag', async () => {
    home = useTempHome();
    captureConsole();
    const failingInit = vi.fn(async () => 1);
    const { deps, statusFn, statusCollector } = makeDeps({ isTTY: true, initFn: failingInit });
    expect(await launch([], deps)).toBe(1);
    expect(failingInit).toHaveBeenCalledTimes(1);
    expect(failingInit).toHaveBeenCalledWith([], { isTTY: true });
    expect(statusFn).not.toHaveBeenCalled();
    expect(statusCollector).not.toHaveBeenCalled();
    // The bare command IS initialization — it never scolds the user to run init.
    expect(stderr).toEqual([]);
  });

  it('initialized + non-TTY: exactly `previously status` output, exit code passthrough', async () => {
    home = useTempHome();
    writeConfigWithPort(3210);
    captureConsole();
    const statusFn = vi.fn(async () => {
      console.log('status output');
      return 1;
    });
    const { deps, initFn, statusCollector } = makeDeps({ isTTY: false, statusFn });
    expect(await launch([], deps)).toBe(1);
    expect(statusFn).toHaveBeenCalledTimes(1);
    expect(stdout.join('\n')).toContain('status output');
    expect(initFn).not.toHaveBeenCalled();
    expect(statusCollector).not.toHaveBeenCalled();
  });

  it('initialized + TTY: prints the status dashboard and returns 0', async () => {
    home = useTempHome();
    writeConfigWithPort(3210);
    captureConsole();
    const { deps, initFn, statusFn, statusCollector } = makeDeps({ isTTY: true });
    expect(await launch([], deps)).toBe(0);
    expect(statusCollector).toHaveBeenCalledTimes(1);
    expect(initFn).not.toHaveBeenCalled();
    expect(statusFn).not.toHaveBeenCalled();

    const out = stdout.join('\n');
    expect(out).toContain('Previously — status');
    expect(out).toContain('Service:');
    expect(out).toContain(`running (pid ${process.pid})`);
    expect(out).toContain('stop with `previously stop`');
    expect(out).toContain('Scribe:');
    expect(out).toContain('Storage:');
    expect(out).toContain('transcribed slice(s)');
    expect(out).toContain('Backend:');
    expect(out).toContain('Commands:');
    expect(out).toContain('previously start · stop · status · logs · open · init');
  });

  it('initialized + TTY, kernel down: points at `previously start`, no stop hint', async () => {
    home = useTempHome();
    writeConfigWithPort(3210);
    captureConsole();
    const statusCollector = vi.fn(async () =>
      fakeStatus({ kernelPid: null, kernelAlive: false, reachable: false, scribePid: null, scribeAlive: false }),
    );
    const { deps } = makeDeps({ isTTY: true, statusCollector });
    expect(await launch([], deps)).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('not running — start with `previously start`');
    expect(out).not.toContain('stop with `previously stop`');
  });
});
