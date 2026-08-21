import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOnPath, maskSecret, scanEnvironment } from '../src/lib/detect.js';

describe('detect', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('findOnPath locates a command in a PATH directory (posix platform)', () => {
    dir = mkdtempSync(join(tmpdir(), 'previously-detect-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'fakecli'), '#!/bin/sh\n');
    expect(findOnPath('fakecli', { pathEnv: bin, platform: 'linux' })).toBe(join(bin, 'fakecli'));
    expect(findOnPath('nope', { pathEnv: bin, platform: 'linux' })).toBeNull();
  });

  it('findOnPath searches multiple PATH entries and honors Windows extensions', () => {
    dir = mkdtempSync(join(tmpdir(), 'previously-detect-'));
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(b, 'fakecli.cmd'), '@echo off\n');
    expect(findOnPath('fakecli', { pathEnv: [a, b].join(delimiter), platform: 'win32' })).toBe(
      join(b, 'fakecli.cmd'),
    );
    // The bare file is not enough for win32 resolution…
    writeFileSync(join(a, 'other'), '');
    expect(findOnPath('other', { pathEnv: a, platform: 'win32' })).toBe(join(a, 'other'));
  });

  it('findOnPath checks path-like commands directly against the fs', () => {
    dir = mkdtempSync(join(tmpdir(), 'previously-detect-'));
    const script = join(dir, 'fixture.js');
    writeFileSync(script, '');
    expect(findOnPath(script, { pathEnv: '' })).toBe(script);
    expect(findOnPath(join(dir, 'missing.js'), { pathEnv: '' })).toBeNull();
  });

  it('maskSecret keeps only edges, e.g. sk-…3f2a', () => {
    expect(maskSecret('sk-abcdef3f2a')).toBe('sk-…3f2a');
    expect(maskSecret('123456789')).toBe('123…6789');
    expect(maskSecret('12345')).toBe('…45');
    expect(maskSecret('1234')).toBe('…');
  });

  it('scanEnvironment detects CLIs, history dirs, and masked API keys', () => {
    dir = mkdtempSync(join(tmpdir(), 'previously-detect-'));
    const bin = join(dir, 'bin');
    const homeDir = join(dir, 'home');
    mkdirSync(bin);
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');

    const scan = scanEnvironment({
      env: { DEEPSEEK_API_KEY: 'sk-deepseek1234', PATH: bin },
      homeDir,
      pathEnv: bin,
      platform: 'linux',
    });

    const claude = scan.clis.find((c) => c.name === 'claude')!;
    expect(claude.found).toBe(true);
    expect(scan.clis.find((c) => c.name === 'codex')!.found).toBe(false);

    expect(scan.historyDirs.find((d) => d.name === 'claude')!.present).toBe(true);
    expect(scan.historyDirs.find((d) => d.name === 'kimi')!.present).toBe(false);

    expect(scan.apiKeys).toEqual([{ env: 'DEEPSEEK_API_KEY', masked: 'sk-…1234' }]);
  });
});
