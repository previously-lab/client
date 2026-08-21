import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as logs } from '../src/commands/logs.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

describe('logs (kernel + scribe)', () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  function capture(): void {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((m) => stderr.push(String(m)));
  }

  function writeLogs(): void {
    const paths = resolvePaths();
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.kernelLogPath, 'kernel-1\nkernel-2\nkernel-3\n', 'utf8');
    writeFileSync(paths.scribeLogPath, 'scribe-1\nscribe-2\n', 'utf8');
  }

  it('tails both logs in labeled sections by default', async () => {
    home = useTempHome();
    writeLogs();
    capture();
    expect(await logs([])).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('==> kernel:');
    expect(out).toContain('kernel-3');
    expect(out).toContain('==> scribe:');
    expect(out).toContain('scribe-2');
  });

  it('-s/--source narrows to a single source', async () => {
    home = useTempHome();
    writeLogs();
    capture();
    expect(await logs(['--source', 'scribe'])).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('scribe-1');
    expect(out).not.toContain('kernel-1');
    expect(out).not.toContain('==> kernel:');
  });

  it('rejects an unknown --source', async () => {
    home = useTempHome();
    capture();
    expect(await logs(['-s', 'bogus'])).toBe(1);
    expect(stderr.join('\n')).toContain('Invalid --source');
  });

  it('marks a missing scribe log inline and still succeeds', async () => {
    home = useTempHome();
    const paths = resolvePaths();
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.kernelLogPath, 'kernel-only\n', 'utf8');
    capture();
    expect(await logs([])).toBe(0);
    expect(stdout.join('')).toContain('(no scribe log yet');
  });

  it('fails honestly when neither log exists', async () => {
    home = useTempHome();
    capture();
    expect(await logs([])).toBe(1);
    expect(stderr.join('\n')).toContain('No kernel log');
    expect(stderr.join('\n')).toContain('scribe');
  });

  it('-n caps each tail', async () => {
    home = useTempHome();
    writeLogs();
    capture();
    expect(await logs(['-n', '1'])).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('kernel-3');
    expect(out).not.toContain('kernel-2');
    expect(out).toContain('scribe-2');
    expect(out).not.toContain('scribe-1');
  });
});
