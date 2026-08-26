import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as install, runUninstall as uninstall, selectTargets } from '../src/commands/install.js';
import { userSharedFilePath, userSkillDir } from '../src/lib/skills.js';

/**
 * Command-level tests for `previously install/uninstall` (skill group).
 * All file writes land in a sandboxed user home via the deps seam; PATH
 * detection runs against fixture bin dirs, never the real machine.
 */

let home: string;
let binDir: string;
let stdout: string[];
let stderr: string[];

const ROOT = 'C:\\mem\\root';
const GROUP_FILES = ['SKILL.md', 'memory.md', 'ingest.md', 'setup.md'];
const SENTINEL_MARK = '<!-- previously:memory:start -->';

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

/** Read every file of an installed skill dir, keyed by file name. */
function readSkillDir(agent: 'claude' | 'kimi'): Record<string, string> {
  const dir = userSkillDir(agent, home);
  const out: Record<string, string> = {};
  for (const name of GROUP_FILES) out[name] = readFileSync(join(dir, name), 'utf8');
  return out;
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
  it('installs the four-file skill group for every detected agent and prints a summary', async () => {
    fakeCli('claude');
    fakeCli('kimi');
    const code = await install([], deps());
    expect(code).toBe(0);
    for (const agent of ['claude', 'kimi'] as const) {
      const files = readSkillDir(agent);
      expect(files['SKILL.md']).toContain('name: previously');
      for (const name of GROUP_FILES) expect(files[name]!.length).toBeGreaterThan(0);
      expect(files['memory.md']).toContain(ROOT);
    }
    expect(existsSync(userSharedFilePath('codex', home))).toBe(false);
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
    expect(readFileSync(userSharedFilePath('codex', home), 'utf8')).toContain(SENTINEL_MARK);
  });

  it('re-running converges: second install reports unchanged, content identical', async () => {
    fakeCli('claude');
    await install([], deps());
    const first = readSkillDir('claude');
    stdout = [];
    const code = await install([], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('[claude] unchanged');
    expect(stdout.join('\n')).not.toContain('[claude] installed into');
    expect(readSkillDir('claude')).toEqual(first);
  });

  it('--dry-run prints the diff and writes nothing', async () => {
    const code = await install(['--claude', '--dry-run'], deps());
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('would install into');
    expect(stdout.join('\n')).toContain('(dry run — nothing written)');
    expect(existsSync(userSkillDir('claude', home))).toBe(false);
  });

  it('migrates a legacy previously-memory skill dir away during install', async () => {
    fakeCli('claude');
    const legacy = join(home, '.claude', 'skills', 'previously-memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'old skill bytes', 'utf8');

    const code = await install([], deps());
    expect(code).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    expect(stdout.join('\n')).toContain('[claude] removed from');
  });
});

describe('previously uninstall', () => {
  it('removes exactly our files/block for the selected agents', async () => {
    fakeCli('claude');
    fakeCli('codex');
    await install([], deps());
    expect(existsSync(userSkillDir('claude', home))).toBe(true);
    expect(existsSync(userSharedFilePath('codex', home))).toBe(true);

    const code = await uninstall([], deps());
    expect(code).toBe(0);
    expect(existsSync(userSkillDir('claude', home))).toBe(false);
    expect(existsSync(userSharedFilePath('codex', home))).toBe(false);
    expect(stdout.join('\n')).toContain('[claude] removed from');
    expect(stdout.join('\n')).toContain('[codex] removed from');
  });

  it('uninstall with nothing installed is a no-op (exit 0, nothing reported)', async () => {
    const code = await uninstall(['--claude'], deps());
    expect(code).toBe(0);
    // Owned skill dirs have no shared file to report "unchanged" against —
    // a nothing-to-do uninstall produces no per-file lines.
    expect(stdout.join('\n')).not.toContain('removed from');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});
