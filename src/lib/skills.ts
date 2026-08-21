import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeAgent } from '../bridge/types.js';

/**
 * The "Previously memory" skill pack (replaces the retired read-only MCP
 * server): ONE canonical markdown document, rendered per agent format.
 *
 * Two delivery channels, both fed by the same document:
 * - User-level install (`previously install`): claude →
 *   `~/.claude/skills/previously-memory/SKILL.md`, kimi →
 *   `~/.kimi/skills/previously-memory/SKILL.md` (both auto-discovered Agent
 *   Skills conventions), codex → a sentinel-delimited block appended to the
 *   shared global `~/.codex/AGENTS.md` (never overwriting foreign content).
 * - Bridge workspace (bridge-exec, per call): a temp cwd carrying the
 *   agent's cwd-convention instruction file — `CLAUDE.md` for claude,
 *   `AGENTS.md` for codex and kimi — so a bridged CLI gets the memory
 *   protocol with zero user config.
 *
 * Invariants: never clobber foreign content, back up a modified file once
 * (`<path>.bak`), stay idempotent — re-running converges without writes.
 */

export const SKILL_NAME = 'previously-memory';

export const MEMORY_ROOT_PLACEHOLDER = '{{MEMORY_ROOT}}';

/** The canonical skill document. `{{MEMORY_ROOT}}` is filled at render time. */
export const SKILL_DOC_TEMPLATE = `# Previously Memory (read-only)

You are running inside Previously, a personal memory assistant. Previously
records the user's conversations with AI agents as time slices on local disk
and gives you read access to that history.

## Memory root

All memory lives under this absolute path:

    {{MEMORY_ROOT}}

Layout (paths relative to the memory root):

- \`episodic/timeline.md\` — the human timeline. Sections \`## YYYY-MM\`
  (month) contain \`### MM-DD\` (day) subsections with one line per slice:
  \`- **YYYY-MM-DD-HHMM** summary · N turns [tags]\`.
- \`episodic/timeline/index.json\` — machine index of slices; the fallback
  when \`timeline.md\` is absent.
- \`episodic/strands.json\` — JSON object mapping strand (topic thread) names
  to arrays of slice paths in \`YYYY/MM/DD/HHMM\` form.
- \`episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md\` — the full conversation
  record of one slice. A slice id \`YYYY-MM-DD-HHMM\` maps to the directory
  \`episodic/slices/YYYY/MM/DD/HHMM/\`.
- \`episodic/slices/YYYY/MM/_index.json\` — monthly manifest listing slice
  ids with summaries and tags; good for scanning before opening full slices.

## Strict rules

- READ-ONLY. Never create, modify, rename, or delete anything under the
  memory root. Conversation persistence is handled by the Previously kernel
  and its scribe — never by you.
- Never fabricate memories. If a file is missing or a lookup finds nothing,
  say so plainly instead of guessing.

## When to recall

Before answering anything about the user's past — prior conversations,
decisions, preferences, people, projects, dates — consult the memory first:
start from \`episodic/timeline.md\` (narrow by month/day), follow
\`episodic/strands.json\` for topic threads, then read the slice's
\`timeline/core.md\` for full context.

## Output contract

Your final reply is rendered verbatim in a web chat UI. It must contain ONLY
the answer text for the user: no tool-call narration, no logs, no
"I searched the memory" preamble, no markdown fences around the whole reply.
`;

/** Render the canonical document with an absolute memory root filled in. */
export function renderSkillDoc(memoryRoot: string): string {
  return SKILL_DOC_TEMPLATE.split(MEMORY_ROOT_PLACEHOLDER).join(memoryRoot);
}

/** SKILL.md form (claude / kimi skills dirs): YAML frontmatter + document. */
export function renderSkillFile(memoryRoot: string): string {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Read-only access to the user\'s Previously long-term memory (timeline, strands, time slices). Recall from it before answering anything about the user\'s past.',
    '---',
    '',
    renderSkillDoc(memoryRoot),
  ].join('\n');
}

/** Sentinel markers delimiting the block we own inside a shared file. */
export const SENTINEL_START = '<!-- previously:memory:start -->';
export const SENTINEL_END = '<!-- previously:memory:end -->';

/** The exact block we own in a shared instructions file (codex AGENTS.md). */
export function sentinelBlock(memoryRoot: string): string {
  return `${SENTINEL_START}\n${renderSkillDoc(memoryRoot).trimEnd()}\n${SENTINEL_END}`;
}

/**
 * Merge (block !== null) or remove (block === null) our sentinel-delimited
 * block in a shared file, preserving every foreign byte. When no sentinel
 * exists yet, the block is appended after a blank line. Returns the new
 * file content (may be '' when removal empties the file).
 */
export function mergeSentinelBlock(existing: string | null, block: string | null): string {
  const text = existing ?? '';
  const start = text.indexOf(SENTINEL_START);
  const end = text.indexOf(SENTINEL_END);

  let stripped: string;
  if (start !== -1 && end !== -1 && end > start) {
    // Replace/remove the region, then collapse the seam's blank lines. A
    // whitespace-only `after` is the newline our own append added — drop it
    // so removal restores the pre-install bytes exactly.
    const before = text.slice(0, start).replace(/\n{2,}$/, '\n');
    let after = text.slice(end + SENTINEL_END.length).replace(/^\n{2,}/, '\n');
    if (after.trim() === '') after = '';
    stripped = (before + after).replace(/\n{3,}/g, '\n\n');
  } else {
    stripped = text;
  }

  if (block === null) return stripped;
  const trimmed = stripped.trimEnd();
  if (trimmed === '') return block + '\n';
  return `${trimmed}\n\n${block}\n`;
}

/** User-level install path per agent (home is injectable for tests). */
export function userSkillPath(agent: BridgeAgent, home: string = homedir()): string {
  switch (agent) {
    case 'claude':
      return join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
    case 'kimi':
      return join(home, '.kimi', 'skills', SKILL_NAME, 'SKILL.md');
    case 'codex':
      return join(home, '.codex', 'AGENTS.md');
  }
}

/**
 * True when the agent's user-level target is a standalone file we own
 * outright (a skill dir) rather than a shared file needing sentinels.
 */
export function ownsTargetFile(agent: BridgeAgent): boolean {
  return agent !== 'codex';
}

/** The cwd-convention instruction file each agent CLI auto-reads. */
export function workspaceFileName(agent: BridgeAgent): string {
  return agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
}

export interface SkillApplyResult {
  target: BridgeAgent;
  path: string;
  action: 'installed' | 'removed' | 'unchanged';
  /** Path of the one-time backup, when one was created on this run. */
  backupPath: string | null;
  oldContent: string | null;
  newContent: string;
}

/** Copy `path` to `<path>.bak` once; never overwrite an existing backup. */
export function backupOnce(path: string): string | null {
  const backupPath = `${path}.bak`;
  if (!existsSync(path) || existsSync(backupPath)) return null;
  copyFileSync(path, backupPath);
  return backupPath;
}

export interface ApplySkillOptions {
  home?: string;
  memoryRoot: string;
  dryRun?: boolean;
}

/**
 * Compute and (unless dryRun) apply one agent's skill install
 * (mode 'install') or removal (mode 'uninstall'). Idempotent: a converged
 * target reports 'unchanged' and writes nothing.
 */
export function applySkillTarget(
  agent: BridgeAgent,
  mode: 'install' | 'uninstall',
  opts: ApplySkillOptions,
): SkillApplyResult {
  const path = userSkillPath(agent, opts.home ?? homedir());
  const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : null;

  if (ownsTargetFile(agent)) {
    // We own the whole file: install rewrites it, uninstall deletes it.
    const newContent = mode === 'install' ? renderSkillFile(opts.memoryRoot) : '';
    if (mode === 'install' && newContent === oldContent) {
      return { target: agent, path, action: 'unchanged', backupPath: null, oldContent, newContent };
    }
    if (mode === 'uninstall' && oldContent === null) {
      return { target: agent, path, action: 'unchanged', backupPath: null, oldContent, newContent };
    }
    let backupPath: string | null = null;
    if (opts.dryRun !== true) {
      if (mode === 'install') {
        backupPath = backupOnce(path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, newContent, 'utf8');
      } else {
        rmSync(path, { force: true });
        removeDirIfEmpty(dirname(path)); // the previously-memory skill dir
      }
    }
    return {
      target: agent,
      path,
      action: mode === 'install' ? 'installed' : 'removed',
      backupPath,
      oldContent,
      newContent,
    };
  }

  // Shared file (codex global AGENTS.md): sentinel-delimited block.
  const newContent = mergeSentinelBlock(
    oldContent,
    mode === 'install' ? sentinelBlock(opts.memoryRoot) : null,
  );
  if (newContent === (oldContent ?? '') && oldContent !== null) {
    return { target: agent, path, action: 'unchanged', backupPath: null, oldContent, newContent };
  }
  if (oldContent === null && mode === 'uninstall') {
    return { target: agent, path, action: 'unchanged', backupPath: null, oldContent, newContent: '' };
  }
  let backupPath: string | null = null;
  if (opts.dryRun !== true) {
    if (newContent.trim() === '') {
      // Removal emptied a file that only ever held our block — delete it.
      rmSync(path, { force: true });
    } else {
      backupPath = backupOnce(path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, newContent, 'utf8');
    }
  }
  return {
    target: agent,
    path,
    action: mode === 'install' ? 'installed' : 'removed',
    backupPath,
    oldContent,
    newContent,
  };
}

/** Remove a directory only when it is empty (never recursive here). */
function removeDirIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Best-effort housekeeping — a leftover empty dir is harmless.
  }
}

export interface BridgeWorkspace {
  /** Temp directory; spawn the agent CLI with cwd set to this. */
  dir: string;
  /** The instruction file written into it (CLAUDE.md / AGENTS.md). */
  filePath: string;
}

/**
 * Materialize the per-call bridge workspace: a temp dir carrying the
 * agent's cwd-convention instruction file with the memory protocol. The
 * caller owns cleanup (rm -rf the dir in a finally block).
 */
export function materializeBridgeWorkspace(agent: BridgeAgent, memoryRoot: string): BridgeWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'previously-bridge-'));
  const filePath = join(dir, workspaceFileName(agent));
  writeFileSync(filePath, renderSkillDoc(memoryRoot), 'utf8');
  return { dir, filePath };
}
