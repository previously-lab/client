import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as openCmd } from '../src/commands/open.js';
import { openBrowser } from '../src/lib/open-browser.js';
import { resolvePaths } from '../src/lib/paths.js';
import { writePidFile } from '../src/lib/process.js';
import { cleanupTempHome, getFreePort, useTempHome, writeConfigWithPort } from './helpers.js';

describe('openBrowser', () => {
  it('uses cmd /c start on Windows', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const result = openBrowser('http://127.0.0.1:3210', {
      platform: 'win32',
      env: {},
      spawnFn: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ cmd: 'cmd', args: ['/c', 'start', '""', 'http://127.0.0.1:3210'] }]);
  });

  it('uses open on macOS', () => {
    const calls: string[] = [];
    const result = openBrowser('http://x', {
      platform: 'darwin',
      env: {},
      spawnFn: (cmd) => calls.push(cmd),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['open']);
  });

  it('fails honestly on Linux when xdg-open is missing', () => {
    const result = openBrowser('http://x', { platform: 'linux', env: { PATH: '' }, spawnFn: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('xdg-open');
  });

  it('respects PREVIOUSLY_NO_OPEN=1 without spawning', () => {
    let spawned = 0;
    const result = openBrowser('http://x', {
      platform: 'darwin',
      env: { PREVIOUSLY_NO_OPEN: '1' },
      spawnFn: () => spawned++,
    });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(spawned).toBe(0);
  });
});

describe('previously open', () => {
  let home: string;
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('fails honestly when nothing is running', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
    expect(await openCmd([])).toBe(1);
    expect(stderr.join('\n')).toContain('not running');
    expect(stderr.join('\n')).toContain('previously');
  });

  it('opens the Web UI when the kernel pid is alive', async () => {
    home = useTempHome();
    const port = await getFreePort();
    writeConfigWithPort(port);
    writePidFile(resolvePaths().pidPath, process.pid);
    const opened: string[] = [];
    expect(await openCmd([], { openBrowserFn: (url) => (opened.push(url), { ok: true }) })).toBe(0);
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
  });
});
