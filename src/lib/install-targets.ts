import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MCP server registration into third-party agent configs (design doc §6).
 *
 * Targets:
 * - Claude Code:  `<project>/.mcp.json` (with --project) or `~/.claude.json`,
 *   under the `mcpServers` key.
 * - Codex:        `~/.codex/config.toml`, `[mcp_servers.previously]` section.
 *   Codex has no documented per-project MCP file, so --project does not move it.
 * - Kimi Code:    `<project>/.kimi-code/mcp.json` (with --project) or
 *   `~/.kimi-code/mcp.json`, under the `mcpServers` key.
 *
 * Invariants: never clobber foreign config entries, back up the file once
 * (`<path>.bak`) before the first modification, and stay idempotent —
 * re-running install/uninstall converges to the same content without writes.
 */

export type InstallTarget = 'claude' | 'codex' | 'kimi';
export const ALL_TARGETS: readonly InstallTarget[] = ['claude', 'codex', 'kimi'];

export const SERVER_NAME = 'previously';

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The stdio command MCP clients spawn. Always the node binary + the absolute
 * path to dist/cli.js — on Windows the npm `.cmd` shim is not directly
 * spawnable by every client, and the absolute cli.js path works everywhere.
 * PREVIOUSLY_HOME is pinned into the server env only when it is explicitly
 * set at install time (e.g. sandboxed/test homes).
 */
export function serverEntry(cliJsPath: string = defaultCliJsPath()): ServerEntry {
  const entry: ServerEntry = {
    command: process.execPath,
    args: [cliJsPath, 'mcp', 'serve'],
  };
  if (process.env.PREVIOUSLY_HOME !== undefined) {
    entry.env = { PREVIOUSLY_HOME: process.env.PREVIOUSLY_HOME };
  }
  return entry;
}

export function defaultCliJsPath(): string {
  // dist/lib/install-targets.js → dist/cli.js
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

export interface TargetScope {
  /** --project <dir>: scope Claude/Kimi registration to a project directory. */
  project?: string;
}

export function targetConfigPath(
  target: InstallTarget,
  scope: TargetScope = {},
  home: string = homedir(),
): string {
  switch (target) {
    case 'claude':
      return scope.project !== undefined
        ? join(scope.project, '.mcp.json')
        : join(home, '.claude.json');
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'kimi':
      return scope.project !== undefined
        ? join(scope.project, '.kimi-code', 'mcp.json')
        : join(home, '.kimi-code', 'mcp.json');
  }
}

/**
 * Merge (entry !== null) or remove (entry === null) our server in a JSON
 * config's `mcpServers` object. Foreign keys are preserved verbatim. Throws on
 * a malformed or non-object existing file rather than clobbering it.
 */
export function mergeJsonMcpServers(existing: string | null, entry: ServerEntry | null): string {
  let config: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error('existing config is not valid JSON — refusing to modify it');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('existing config is not a JSON object — refusing to modify it');
    }
    config = parsed as Record<string, unknown>;
  }

  const servers: Record<string, unknown> = { ...(config.mcpServers as Record<string, unknown> | undefined) };
  if (entry !== null) {
    servers[SERVER_NAME] = entry.env !== undefined
      ? { command: entry.command, args: entry.args, env: entry.env }
      : { command: entry.command, args: entry.args };
    config.mcpServers = servers;
  } else {
    delete servers[SERVER_NAME];
    if (Object.keys(servers).length > 0) config.mcpServers = servers;
    else delete config.mcpServers;
  }
  return JSON.stringify(config, null, 2) + '\n';
}

/** TOML basic-string escaping (JSON string syntax is a valid subset here). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The exact TOML block we own, for install and for tests. */
export function codexServerBlock(entry: ServerEntry): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
  if (entry.env !== undefined) {
    lines.push('', `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [key, value] of Object.entries(entry.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Merge or remove our `[mcp_servers.previously]` section in a TOML config,
 * preserving every other line byte-for-byte. Minimal by design: we own exactly
 * the `[mcp_servers.previously]` header and its sub-tables; anything else is
 * foreign and untouched.
 */
export function mergeTomlMcpServers(existing: string | null, entry: ServerEntry | null): string {
  const lines = existing === null ? [] : existing.split('\n');
  // A trailing newline leaves a final empty element; keep track so the output
  // ends with exactly one newline.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const isOurHeader = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed === `[mcp_servers.${SERVER_NAME}]` || trimmed.startsWith(`[mcp_servers.${SERVER_NAME}.`)
    );
  };
  const isAnyHeader = (line: string): boolean => line.trim().startsWith('[');

  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (isOurHeader(line)) {
      skipping = true;
      continue;
    }
    if (skipping && isAnyHeader(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  // Trim blank lines left behind at the seam where our section was removed.
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();

  if (entry !== null) kept.push(codexServerBlock(entry));
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}

export interface ApplyResult {
  target: InstallTarget;
  path: string;
  action: 'installed' | 'removed' | 'unchanged';
  /** Path of the one-time backup, when one was created on this run. */
  backupPath: string | null;
  oldContent: string | null;
  newContent: string;
}

function mergeForTarget(target: InstallTarget, existing: string | null, entry: ServerEntry | null): string {
  return target === 'codex'
    ? mergeTomlMcpServers(existing, entry)
    : mergeJsonMcpServers(existing, entry);
}

/**
 * Compute and (unless dryRun) apply one target's config change.
 * `entry === null` means uninstall.
 */
export function applyTarget(
  target: InstallTarget,
  entry: ServerEntry | null,
  scope: TargetScope = {},
  opts: { dryRun?: boolean; home?: string } = {},
): ApplyResult {
  const path = targetConfigPath(target, scope, opts.home);
  const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : null;

  // Uninstalling from a file that doesn't exist is a no-op success.
  if (oldContent === null && entry === null) {
    return { target, path, action: 'unchanged', backupPath: null, oldContent, newContent: '' };
  }

  let newContent: string;
  try {
    newContent = mergeForTarget(target, oldContent, entry);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (newContent === oldContent) {
    return { target, path, action: 'unchanged', backupPath: null, oldContent, newContent };
  }

  let backupPath: string | null = null;
  if (opts.dryRun !== true) {
    backupPath = backupOnce(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, newContent, 'utf8');
  }
  return {
    target,
    path,
    action: entry !== null ? 'installed' : 'removed',
    backupPath,
    oldContent,
    newContent,
  };
}

/** Copy `path` to `<path>.bak` once; never overwrite an existing backup. */
export function backupOnce(path: string): string | null {
  const backupPath = `${path}.bak`;
  if (!existsSync(path) || existsSync(backupPath)) return null;
  copyFileSync(path, backupPath);
  return backupPath;
}
