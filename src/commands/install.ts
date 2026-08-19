import { parseArgs } from 'node:util';
import { diffLines } from '../lib/diff.js';
import {
  ALL_TARGETS,
  applyTarget,
  serverEntry,
  type ApplyResult,
  type InstallTarget,
} from '../lib/install-targets.js';

function usage(mode: 'install' | 'uninstall'): void {
  console.log(`previously ${mode} — ${mode === 'install' ? 'register' : 'remove'} the local MCP server ${
    mode === 'install' ? 'in' : 'from'
  } agent configs

Usage: previously ${mode} --claude | --codex | --kimi | --all [options]

Targets:
  --claude    Claude Code: ~/.claude.json (or <dir>/.mcp.json with --project)
  --codex     Codex: ~/.codex/config.toml
  --kimi      Kimi Code: ~/.kimi-code/mcp.json (or <dir>/.kimi-code/mcp.json with --project)
  --all       All of the above

Options:
  --project <dir>  Scope Claude/Kimi registration to a project directory
  --dry-run        Print the resulting diff without writing anything

Only Previously's own entries are touched; other servers' config is preserved.
Before the first modification each file is backed up once to <file>.bak.
`);
}

interface ParsedFlags {
  targets: InstallTarget[];
  project?: string;
  dryRun: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const { values } = parseArgs({
    args,
    options: {
      claude: { type: 'boolean' },
      codex: { type: 'boolean' },
      kimi: { type: 'boolean' },
      all: { type: 'boolean' },
      project: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });

  const targets: InstallTarget[] = [];
  if (values.all === true) {
    targets.push(...ALL_TARGETS);
  } else {
    if (values.claude === true) targets.push('claude');
    if (values.codex === true) targets.push('codex');
    if (values.kimi === true) targets.push('kimi');
  }
  if (targets.length === 0) {
    throw new Error('requires at least one target: --claude / --codex / --kimi / --all');
  }
  return {
    targets,
    ...(values.project !== undefined ? { project: values.project } : {}),
    dryRun: values['dry-run'] === true,
  };
}

function report(results: ApplyResult[], dryRun: boolean): void {
  for (const r of results) {
    const verb =
      r.action === 'unchanged'
        ? 'unchanged'
        : dryRun
          ? r.action === 'installed'
            ? 'would install into'
            : 'would remove from'
          : r.action === 'installed'
            ? 'installed into'
            : 'removed from';
    console.log(`[${r.target}] ${verb} ${r.path}`);
    if (r.backupPath !== null) console.log(`  backup: ${r.backupPath}`);
    if (dryRun && r.action !== 'unchanged') {
      console.log(diffLines(r.oldContent ?? '', r.newContent));
    }
  }
  if (dryRun) console.log('(dry run — nothing written)');
}

async function runMode(args: string[], mode: 'install' | 'uninstall'): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    usage(mode);
    return 0;
  }

  let flags: ParsedFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage(mode);
    return 1;
  }

  const entry = mode === 'install' ? serverEntry() : null;
  const results: ApplyResult[] = [];
  for (const target of flags.targets) {
    try {
      results.push(
        applyTarget(
          target,
          entry,
          flags.project !== undefined ? { project: flags.project } : {},
          { dryRun: flags.dryRun },
        ),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  report(results, flags.dryRun);
  return 0;
}

/** `previously install` — register the MCP server into agent configs. */
export async function run(args: string[]): Promise<number> {
  return runMode(args, 'install');
}

/** `previously uninstall` — remove exactly our entries from agent configs. */
export async function runUninstall(args: string[]): Promise<number> {
  return runMode(args, 'uninstall');
}
