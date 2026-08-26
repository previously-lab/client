import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as start } from '../src/commands/start.js';
import { run as stop } from '../src/commands/stop.js';
import { defaultConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, getFreePort, useTempHome, writeConfigWithPort, writeFixtureKernel } from './helpers.js';

/**
 * `previously start` focuses here on the two gates that run BEFORE any
 * process is spawned: init delegation when config.json is missing (via the
 * initFn seam), and the config doctor. The full kernel lifecycle against the
 * fixture kernel lives in kernel.test.ts; only the repair test below boots
 * the fixture kernel for real (startScribe: false, short health timeout).
 */
describe('previously start — init delegation and config doctor', () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = useTempHome();
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Belt and braces: never leak a fixture kernel between tests.
    await stop([], { graceTimeoutMs: 3_000 });
    cleanupTempHome(home);
  });

  it('uninitialized: delegates to initFn and aborts when init fails', async () => {
    const initFn = vi.fn(async () => 1);
    expect(await start([], { initFn, startScribe: false, healthTimeoutMs: 1_000 })).toBe(1);
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(stdout.join('\n')).toContain('not initialized yet — running init first');
    expect(stderr.join('\n')).toContain('Initialization failed');
    // Aborted before anything was launched.
    expect(existsSync(resolvePaths().pidPath)).toBe(false);
  });

  it('uninitialized: a successful initFn continues into the normal start flow', async () => {
    // init succeeds but installs no kernel artifact → start must continue
    // past init and fail honestly at the artifact check.
    const initFn = vi.fn(async () => {
      writeConfigWithPort(await getFreePort());
      return 0;
    });
    expect(await start([], { initFn, startScribe: false, healthTimeoutMs: 1_000 })).toBe(1);
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(stderr.join('\n')).toContain('Kernel artifact not found');
  });

  it('an initialized home never calls initFn', async () => {
    writeConfigWithPort(await getFreePort());
    const initFn = vi.fn(async () => 0);
    // No kernel artifact → exit 1, but crucially without delegating to init.
    expect(await start([], { initFn, startScribe: false, healthTimeoutMs: 1_000 })).toBe(1);
    expect(initFn).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('Kernel artifact not found');
  });

  it('repairs a broken config (missing bridge brain) before launching the kernel', async () => {
    const paths = resolvePaths();
    mkdirSync(paths.home, { recursive: true });
    // backend=claude with no brain — the incident config the doctor fixes.
    writeFileSync(
      paths.configPath,
      JSON.stringify({ ...defaultConfig(paths), port: await getFreePort(), executionBackend: 'claude' }),
      'utf8',
    );
    writeFixtureKernel(home);

    expect(await start([], { healthTimeoutMs: 15_000, startScribe: false })).toBe(0);
    expect(stdout.join('\n')).toContain('repaired: brain missing while backend is "claude"');

    // The kernel was launched with the repaired config: brain is persisted.
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    expect(config.brain).toEqual({ type: 'bridge', agent: 'claude' });
    // The broken original was backed up before the rewrite.
    const bak = JSON.parse(readFileSync(`${paths.configPath}.bak`, 'utf8'));
    expect(bak.executionBackend).toBe('claude');
    expect(bak.brain).toBeUndefined();
  });
});
