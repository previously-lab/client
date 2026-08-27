import { parseArgs } from 'node:util';
import { BRIDGE_AGENTS, type BridgeAgent } from '../bridge/types.js';
import { loadConfig } from '../lib/config.js';
import { findOnPath } from '../lib/detect.js';
import { diffLines } from '../lib/diff.js';
import { resolvePaths } from '../lib/paths.js';
import { applySkillTarget, type SkillApplyResult } from '../lib/skills.js';
import { bold, emph, err as errText, green, muted, styleDiff, styleHelp, yellow } from '../lib/ansi.js';

function usage(mode: 'install' | 'uninstall'): void {
  console.log(styleHelp(`previously ${mode} — ${mode === 'install' ? 'write' : 'remove'} the "Previously" skill group ${
    mode === 'install' ? 'for' : 'from'
  } local agent CLIs

Usage: previously ${mode} [--claude] [--codex] [--kimi] [--all] [options]

Targets (default: every agent CLI detected on PATH):
  --claude    Claude Code: ~/.claude/skills/previously/ (SKILL.md + memory.md + ingest.md + setup.md)
  --codex     Codex: a sentinel-delimited block in the shared ~/.codex/AGENTS.md
  --kimi      Kimi Code: ~/.kimi/skills/previously/ (same four documents)
  --all       All three agents, detected or not

Options:
  --dry-run   Print the resulting diff without writing anything

Only Previously's own files / sentinel block are touched; foreign content is
preserved verbatim. Before the first modification each file is backed up once
to <file>.bak. Re-running converges idempotently. A legacy previously-memory
skill dir from older versions is migrated away automatically.

Note: the read-only MCP server (previously mcp) is retired — this skill pack
replaces it. Bridged agents also get the memory protocol per call via the
bridge-exec temp workspace (CLAUDE.md / AGENTS.md), no install needed.
`));
}

/** Dependency seams so tests never touch the real PATH or home. */
export interface InstallDeps {
  home?: string;
  memoryRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

interface ParsedFlags {
  explicit: BridgeAgent[];
  all: boolean;
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
      'dry-run': { type: 'boolean' },
    },
  });
  const explicit: BridgeAgent[] = [];
  if (values.claude === true) explicit.push('claude');
  if (values.codex === true) explicit.push('codex');
  if (values.kimi === true) explicit.push('kimi');
  return { explicit, all: values.all === true, dryRun: values['dry-run'] === true };
}

/**
 * Target selection: explicit flags win; otherwise every bridge agent CLI
 * found on PATH (per src/lib/detect.ts conventions).
 */
export function selectTargets(
  flags: ParsedFlags,
  deps: Pick<InstallDeps, 'pathEnv' | 'platform'> = {},
): BridgeAgent[] {
  if (flags.all) return [...BRIDGE_AGENTS];
  if (flags.explicit.length > 0) return flags.explicit;
  return BRIDGE_AGENTS.filter((agent) => findOnPath(agent, deps) !== null);
}

function report(results: SkillApplyResult[], dryRun: boolean): void {
  for (const r of results) {
    const verb =
      r.action === 'unchanged'
        ? muted('unchanged')
        : dryRun
          ? r.action === 'installed'
            ? green('would install into')
            : yellow('would remove from')
          : r.action === 'installed'
            ? green('installed into')
            : yellow('removed from');
    console.log(`[${bold(r.target)}] ${verb} ${emph(r.path)}`);
    if (r.backupPath !== null) console.log(`  backup: ${muted(r.backupPath)}`);
    if (dryRun && r.action !== 'unchanged') {
      console.log(styleDiff(diffLines(r.oldContent ?? '', r.newContent)));
    }
  }
  if (dryRun) console.log(muted('(dry run — nothing written)'));
}

async function runMode(args: string[], mode: 'install' | 'uninstall', deps: InstallDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    usage(mode);
    return 0;
  }

  let flags: ParsedFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    console.error(errText(err instanceof Error ? err.message : String(err)));
    usage(mode);
    return 1;
  }

  const memoryRoot = deps.memoryRoot ?? loadConfig(resolvePaths()).memoryRoot;
  const targets = selectTargets(flags, deps);
  if (targets.length === 0) {
    console.log(muted('No agent CLIs detected on PATH (claude / codex / kimi).'));
    console.log(`Pass ${bold('--claude / --codex / --kimi / --all')} to install anyway.`);
    return 0;
  }

  const results: SkillApplyResult[] = [];
  for (const target of targets) {
    try {
      results.push(
        ...applySkillTarget(target, mode, {
          memoryRoot,
          dryRun: flags.dryRun,
          ...(deps.home !== undefined ? { home: deps.home } : {}),
        }),
      );
    } catch (err) {
      console.error(errText(err instanceof Error ? err.message : String(err)));
      return 1;
    }
  }
  report(results, flags.dryRun);
  return 0;
}

/** `previously install` — write the memory skill pack for local agent CLIs. */
export async function run(args: string[], deps: InstallDeps = {}): Promise<number> {
  return runMode(args, 'install', deps);
}

/** `previously uninstall` — remove exactly our skill files / sentinel block. */
export async function runUninstall(args: string[], deps: InstallDeps = {}): Promise<number> {
  return runMode(args, 'uninstall', deps);
}
