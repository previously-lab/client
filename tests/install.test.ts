import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTarget,
  codexServerBlock,
  mergeJsonMcpServers,
  mergeTomlMcpServers,
  serverEntry,
  targetConfigPath,
  type ServerEntry,
} from '../src/lib/install-targets.js';

/** Sandboxed HOME for agent config files — never the real user home. */
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'previously-install-test-'));
  delete process.env.PREVIOUSLY_HOME; // keep env out of the entry unless a test sets it
});

afterEach(() => {
  delete process.env.PREVIOUSLY_HOME;
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('serverEntry (spawn command form)', () => {
  it('spawns node + absolute cli.js path, never a .cmd shim', () => {
    const entry = serverEntry();
    expect(entry.command).toBe(process.execPath);
    expect(entry.command.endsWith('.cmd')).toBe(false);
    expect(entry.args[0]).toBeDefined();
    expect(isAbsolute(entry.args[0]!)).toBe(true);
    expect(entry.args[0]!.endsWith('cli.js')).toBe(true);
    expect(entry.args.slice(1)).toEqual(['mcp', 'serve']);
  });

  it('pins PREVIOUSLY_HOME into the server env only when set', () => {
    expect(serverEntry().env).toBeUndefined();
    process.env.PREVIOUSLY_HOME = home;
    expect(serverEntry().env).toEqual({ PREVIOUSLY_HOME: home });
  });
});

describe('target config paths', () => {
  it('resolves user-level and project-scoped paths', () => {
    expect(targetConfigPath('claude', {}, home)).toBe(join(home, '.claude.json'));
    expect(targetConfigPath('claude', { project: '/proj' }, home)).toBe(join('/proj', '.mcp.json'));
    expect(targetConfigPath('codex', {}, home)).toBe(join(home, '.codex', 'config.toml'));
    // Codex has no documented per-project MCP file; --project does not move it.
    expect(targetConfigPath('codex', { project: '/proj' }, home)).toBe(join(home, '.codex', 'config.toml'));
    expect(targetConfigPath('kimi', {}, home)).toBe(join(home, '.kimi-code', 'mcp.json'));
    expect(targetConfigPath('kimi', { project: '/proj' }, home)).toBe(
      join('/proj', '.kimi-code', 'mcp.json'),
    );
  });
});

describe('JSON merge (Claude / Kimi)', () => {
  const entry: ServerEntry = { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp', 'serve'] };

  it('creates mcpServers from an empty file', () => {
    const merged = JSON.parse(mergeJsonMcpServers(null, entry)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(merged.mcpServers.previously).toEqual({ command: entry.command, args: entry.args });
  });

  it('preserves foreign servers and foreign top-level keys', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'other-bin' } }, theme: 'dark' });
    const merged = JSON.parse(mergeJsonMcpServers(existing, entry)) as {
      mcpServers: Record<string, unknown>;
      theme: string;
    };
    expect(merged.mcpServers.other).toEqual({ command: 'other-bin' });
    expect(merged.mcpServers.previously).toBeDefined();
    expect(merged.theme).toBe('dark');
  });

  it('removal deletes only our entry and keeps the rest', () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: 'other-bin' }, previously: { command: 'old' } },
    });
    const merged = JSON.parse(mergeJsonMcpServers(existing, null)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.previously).toBeUndefined();
    expect(merged.mcpServers.other).toEqual({ command: 'other-bin' });
  });

  it('removal of the last entry drops the empty mcpServers key', () => {
    const merged = JSON.parse(
      mergeJsonMcpServers(JSON.stringify({ mcpServers: { previously: {} }, keep: 1 }), null),
    ) as Record<string, unknown>;
    expect(merged.mcpServers).toBeUndefined();
    expect(merged.keep).toBe(1);
  });

  it('refuses to clobber malformed JSON', () => {
    expect(() => mergeJsonMcpServers('{not json', entry)).toThrowError(/not valid JSON/);
    expect(() => mergeJsonMcpServers('[1,2]', entry)).toThrowError(/not a JSON object/);
  });
});

describe('TOML merge (Codex)', () => {
  const entry: ServerEntry = { command: 'C:\\node\\node.exe', args: ['C:\\x\\cli.js', 'mcp', 'serve'] };

  it('escapes Windows paths as valid TOML basic strings', () => {
    const block = codexServerBlock(entry);
    expect(block).toContain('command = "C:\\\\node\\\\node.exe"');
    expect(block).toContain('"C:\\\\x\\\\cli.js"');
  });

  it('appends our section while preserving foreign content', () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const merged = mergeTomlMcpServers(existing, entry);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain('[mcp_servers.previously]');
  });

  it('replaces our own stale section instead of duplicating it', () => {
    const once = mergeTomlMcpServers('model = "gpt-5"\n', entry);
    const twice = mergeTomlMcpServers(once, { ...entry, command: '/new/node' });
    expect(twice.match(/\[mcp_servers\.previously\]/g)).toHaveLength(1);
    expect(twice).toContain('"/new/node"');
    expect(twice).toContain('model = "gpt-5"');
  });

  it('removes our section (and env sub-table) without touching others', () => {
    const withEnv: ServerEntry = { ...entry, env: { PREVIOUSLY_HOME: '/home/x/.previously' } };
    const installed = mergeTomlMcpServers('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "o"\n', withEnv);
    expect(installed).toContain('[mcp_servers.previously.env]');
    const removed = mergeTomlMcpServers(installed, null);
    expect(removed).not.toContain('previously');
    expect(removed).toContain('[mcp_servers.other]');
    expect(removed).toContain('model = "gpt-5"');
  });
});

describe('applyTarget round-trips', () => {
  it('claude: install → uninstall, foreign entries preserved, idempotent', () => {
    const path = targetConfigPath('claude', {}, home);
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'o' } } }, null, 2));

    const entry = serverEntry();
    const install1 = applyTarget('claude', entry, {}, { home });
    expect(install1.action).toBe('installed');
    const afterInstall = JSON.parse(read(path)) as { mcpServers: Record<string, unknown> };
    expect(afterInstall.mcpServers.previously).toBeDefined();
    expect(afterInstall.mcpServers.other).toEqual({ command: 'o' });

    // Idempotent: second install is a no-op.
    const install2 = applyTarget('claude', serverEntry(), {}, { home });
    expect(install2.action).toBe('unchanged');

    const uninstall1 = applyTarget('claude', null, {}, { home });
    expect(uninstall1.action).toBe('removed');
    const afterUninstall = JSON.parse(read(path)) as { mcpServers: Record<string, unknown> };
    expect(afterUninstall.mcpServers.previously).toBeUndefined();
    expect(afterUninstall.mcpServers.other).toEqual({ command: 'o' });

    expect(applyTarget('claude', null, {}, { home }).action).toBe('unchanged');
  });

  it('codex: install → uninstall round-trip with foreign config intact', () => {
    const path = targetConfigPath('codex', {}, home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "o"\n';
    writeFileSync(path, original);

    applyTarget('codex', serverEntry(), {}, { home });
    const installed = read(path);
    expect(installed).toContain('[mcp_servers.previously]');
    expect(installed).toContain(original.trim());

    const result = applyTarget('codex', null, {}, { home });
    expect(result.action).toBe('removed');
    expect(read(path)).toBe(original);
    expect(applyTarget('codex', null, {}, { home }).action).toBe('unchanged');
  });

  it('kimi: install creates nested dirs, project scope works', () => {
    const entry = serverEntry();
    const userResult = applyTarget('kimi', entry, {}, { home });
    expect(existsSync(userResult.path)).toBe(true);

    const project = join(home, 'some-project');
    const projectResult = applyTarget('kimi', entry, { project }, { home });
    expect(projectResult.path).toBe(join(project, '.kimi-code', 'mcp.json'));
    expect(JSON.parse(read(projectResult.path))).toHaveProperty('mcpServers.previously');
  });

  it('backs up once before first modification, never overwriting the backup', () => {
    const path = targetConfigPath('claude', {}, home);
    const original = JSON.stringify({ mcpServers: { other: { command: 'o' } } });
    writeFileSync(path, original);

    const first = applyTarget('claude', serverEntry(), {}, { home });
    expect(first.backupPath).toBe(`${path}.bak`);
    expect(read(`${path}.bak`)).toBe(original);

    writeFileSync(path, JSON.stringify({ changed: true }));
    const second = applyTarget('claude', serverEntry(), {}, { home });
    expect(second.backupPath).toBeNull(); // backup already exists — untouched
    expect(read(`${path}.bak`)).toBe(original);
  });

  it('dry-run computes but never writes, and carries the diff inputs', () => {
    const path = targetConfigPath('claude', {}, home);
    const result = applyTarget('claude', serverEntry(), {}, { home, dryRun: true });
    expect(result.action).toBe('installed');
    expect(result.oldContent).toBeNull();
    expect(result.newContent).toContain('"previously"');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('uninstall from a missing file is a no-op success', () => {
    const result = applyTarget('claude', null, {}, { home });
    expect(result.action).toBe('unchanged');
  });

  it('refuses to modify malformed existing config', () => {
    const path = targetConfigPath('claude', {}, home);
    writeFileSync(path, '{broken');
    expect(() => applyTarget('claude', serverEntry(), {}, { home })).toThrowError(/not valid JSON/);
    expect(read(path)).toBe('{broken'); // untouched
  });
});
