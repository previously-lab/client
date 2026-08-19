import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { serveStdio } from '../mcp/server.js';

function serverVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

function usage(): void {
  console.log(`previously mcp — local read-only MCP server

Usage: previously mcp <subcommand>

Subcommands:
  serve     Serve MCP over stdio (newline-delimited JSON-RPC). This command is
            meant to be spawned by MCP clients (Claude Code, Codex, Kimi Code)
            via the config entries written by \`previously install\`.
`);
}

/**
 * `previously mcp serve` — expose the local memory directory as read-only MCP
 * tools over stdio (design doc §6). stdout carries protocol messages only;
 * anything human-readable goes to stderr.
 */
export async function run(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub === '--help' || sub === '-h') {
    usage();
    return 0;
  }
  if (sub !== 'serve') {
    if (sub !== undefined) console.error(`Unknown mcp subcommand: ${sub}`);
    usage();
    return 1;
  }

  const config = loadConfig();
  await serveStdio({
    memoryRoot: config.memoryRoot,
    serverInfo: { name: 'previously', version: serverVersion() },
  });
  return 0;
}
