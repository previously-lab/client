import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as install, runUninstall as uninstall, selectTargets } from '../src/commands/install.js';
import { userSkillPath } from '../src/lib/skills.js';

/**
 * Command-level tests for `previously install/uninstall` (skill pack).
 * All file writes land in a sandboxed user home via the deps seam; PATH
 * detection runs against fixture bin dirs, never the real machine.
 */

let home: string;
let binDir: string;
let stdout: string[];
let stderr: string[];

const ROOT = 'C:\\mem\\root';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'previously-install-test-'));
  binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Drop an empty executable file named after the CLI into the fixture bin dir. */
function fakeCli(name: string): void {
  writeFileSync(join(binDir, name), '', 'utf8');
}

const deps = () => ({ home, memoryRoot: ROOT, pathEnv: binDir, platform: 'linux' as const });

describe('selectTargets', () => {
  it('no flags → every bridge agent CLI found on PATH', () => {
    fakeCli('claude');
    fakeCli('kimi');
    expect(selectTargets({ explicit: [], all: false, dryRun: false }, { pathEnv: binDir, platform: 'linux' })).toEqual([
      'claude',
      'kimi',
    ]);
  });

  it('explicit flags win over detection; --all covers everything', () => {
    fakeCli('claude');
    const detected = { pathEnv: binDir, platform: 'linux' as const };
    expect(selectTargets({ explicit: ['codex'], all: false, dryRun: false }, detected)).toEqual(['codex']);
    expect(selectTargets({ explicit: [], all: true, dryRun: false }, detected)).toEqual(['claude', 'codex', 'kimi']);
  });
});

describe('previously install', () => {
  it('installs for every detected agent and prints a summary', async () => {
    fakeCli('claude');
    fakeCli('kimi');
    const code = await install([], deps());
    expect(code).toBe(0);
    expect(readFileSync(userSkillPath('claude', home), 'utf8')).toContain(ROOT);
    expect(readFileSync(userSkillPath('kimi', home), 'utf8')).toContain(ROOT);
    expect(existsSync(userSkillPath('codex', home))).toBe(false);
    const out = stdout.join('\n');
    expect(out).toContain('[claude] installed into');
    expect(out).toContain('[kimi] installed into');
    expect(out).not.toContain('[codex]');
  });

  it('no detected agents and no flags → honest message, nothing written', async () => {
    const code = await install([], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('No agent CLIs detected on PATH');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('explicit flag installs regardless of PATH detection', async () => {
    const code = await install(['--codex'], deps());
    expect(code).toBe(0);
    expect(readFileSync(userSkillPath('codex', home), 'utf8')).toContain(SENTINEL_MARK);
  });

  it('re-running converges: second install reports unchanged, content identical', async () => {
    fakeCli('claude');
    await install([], deps());
    const first = readFileSync(userSkillPath('claude', home), 'utf8');
    stdout = [];
    const code = await install([], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('[claude] unchanged');
    expect(readFileSync(userSkillPath('claude', home), 'utf8')).toBe(first);
  });

  it('--dry-run prints the diff and writes nothing', async () => {
    const code = await install(['--claude', '--dry-run'], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('would install into');
    expect(stdout.join('\n')).toContain('(dry run — nothing written)');
    expect(existsSync(userSkillPath('claude', home))).toBe(false);
  });
});

describe('previously uninstall', () => {
  it('removes exactly our files/block for the selected agents', async () => {
    fakeCli('claude');
    fakeCli('codex');
    await install([], deps());
    expect(existsSync(userSkillPath('claude', home))).toBe(true);
    expect(existsSync(userSkillPath('codex', home))).toBe(true);

    const code = await uninstall([], deps());
    expect(code).toBe(0);
    expect(existsSync(userSkillPath('claude', home))).toBe(false);
    expect(existsSync(userSkillPath('codex', home))).toBe(false);
    expect(stdout.join('\n')).toContain('[claude] removed from');
    expect(stdout.join('\n')).toContain('[codex] removed from');
  });

  it('uninstall with nothing installed is an unchanged no-op', async () => {
    const code = await uninstall(['--claude'], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('[claude] unchanged');
  });
});

const SENTINEL_MARK = '<!-- previously:memory:start -->';
