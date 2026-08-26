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
 * The "Previously" skill pack (replaces the retired read-only MCP server):
 * a small GROUP of canonical markdown documents, rendered per agent format.
 *
 * Documents (one skill dir, four files):
 * - SKILL.md  — overview: what Previously is, the doc map, the top-level rules.
 * - memory.md — the read-only memory protocol (recall before answering about
 *   the user's past; directory layout; never write the memory root).
 * - ingest.md — the WRITE contract: how external agents hand content to
 *   `previously ingest` (raw logs or fully-rendered slice documents), the
 *   validation loop, and which steps spend tokens.
 * - setup.md  — the bootstrap walkthrough: init, start, history ingest, card
 *   bootstrap, with an explicit token-cost disclosure per step.
 *
 * Two delivery channels, both fed by the same documents:
 * - User-level install (`previously install`): claude →
 *   `~/.claude/skills/previously/`, kimi → `~/.kimi/skills/previously/`
 *   (auto-discovered Agent Skills conventions, one file per document),
 *   codex → a sentinel-delimited block appended to the shared global
 *   `~/.codex/AGENTS.md` (all four documents concatenated; never overwriting
 *   foreign content). The legacy `previously-memory` skill dir is migrated
 *   away on install.
 * - Bridge workspace (bridge-exec, per call): a temp cwd carrying the
 *   agent's cwd-convention instruction file — `CLAUDE.md` for claude,
 *   `AGENTS.md` for codex and kimi — with the memory protocol (or the
 *   phase-specific doc). Bridged agents get recall with zero user config.
 *
 * Invariants: never clobber foreign content, back up a modified file once
 * (`<path>.bak`), stay idempotent — re-running converges without writes.
 */

export const SKILL_NAME = 'previously';
/** The pre-group single-document skill; install migrates it away. */
export const LEGACY_SKILL_NAME = 'previously-memory';

export const MEMORY_ROOT_PLACEHOLDER = '{{MEMORY_ROOT}}';

/** The canonical memory document. `{{MEMORY_ROOT}}` is filled at render time. */
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

const OVERVIEW_DOC_TEMPLATE = `# Previously

Previously is the user's personal memory assistant, running on this machine.
It keeps a layered episodic memory of the user's past conversations with AI
agents as "time slices" on local disk, maintains a living "Previously On"
card (前情提要), and serves a local Web UI.

## Document map

- **memory.md** — READ access to the memory. Recall from it before answering
  anything about the user's past.
- **ingest.md** — WRITE access: how to contribute conversations to the memory
  through \`previously ingest\` (validation-gated; you never write memory
  files yourself), and how to bootstrap the card.
- **setup.md** — first-run setup: initialize, start, import history. Follow
  it when the user asks you to "set up / 初始化 Previously".

## The rules that matter most

- The memory directory is yours to READ (see memory.md), NEVER to write.
  All writes go through the \`previously\` CLI, which validates and stores.
- Steps that spend model tokens are always marked as such; ask the user
  before running them.
- Never fabricate memories. Gaps are reported, not filled with guesses.
`;

const INGEST_DOC_TEMPLATE = `# Previously Ingest (write access)

You can contribute conversations to Previously memory — but ONLY through the
\`previously ingest\` command, which validates everything and writes it
itself. Never create or edit files under the memory root directly.

Memory root:

    {{MEMORY_ROOT}}

## Mode 1 — hand over raw session logs (no token cost)

When the content is a session log from Claude Code, Codex, Kimi Code, or
Gemini CLI, hand us the raw data and our transcription pipeline does the
parsing, slicing, and storage:

- \`previously ingest --source claude-code|codex|kimi-code|gemini\` — scan that
  agent's standard log directory and ingest everything found (history import).
- \`previously ingest --source <source> --path <file>\` — ingest one specific
  log file (e.g. an export from another machine).
- \`previously ingest --source <source> --root <dir>\` — scan a custom
  directory instead of the standard one.

This mode is pure local processing: no model calls, no token cost. Content
already transcribed by the Previously scribe is deduplicated automatically
(byte-identical re-ingest is a no-op).

## Mode 2 — submit a fully-rendered slice document (no token cost)

When you processed a conversation yourself, submit ONE complete time-slice
document (\`previously ingest --submit <file>\`, or \`--submit -\` on stdin).
We validate strictly; ANY violation rejects the whole submission with a
complete issue list — fix and resubmit. Nothing is ever partially written.

The document format (this is a contract — follow it exactly):

    ---
    slice_id: 2026-01-15-1430        # YYYY-MM-DD-HHMM, UTC, = the start minute
    status: closed                   # ingested slices are historical: always closed
    start: '2026-01-15T14:30:12.000Z'   # ISO 8601
    end: '2026-01-15T15:05:40.000Z'     # ISO 8601, >= start
    timezone: Asia/Shanghai          # optional
    source: claude-code              # provenance label (required, free-form)
    session_id: 0f8a...              # provenance id (required; used for dedup)
    focus: '...'                     # optional; may be empty
    summary: '...'                   # optional; <=100 chars; may be empty
    tags: [topic-a, topic-b]         # optional flow array; [] is fine
    ---
    ## Turn a1B2c3 — 2026-01-15T14:30:12.000Z (user)

    <the user's message, verbatim>

    ## Turn x9Y8z7 — 2026-01-15T14:31:03.000Z (agent)

    <the agent's reply, verbatim>

Hard rules:

- \`slice_id\` must equal the UTC minute of \`start\`.
- Turn headers are exactly \`## Turn <id> — <ISO timestamp> (user|agent)\`
  (em dash). Turn ids: 1-16 chars of A-Za-z0-9_-. Timestamps non-decreasing.
  Every turn needs a non-empty body. No text before the first turn header.
- Frontmatter values are single-line only (no \`>-\` block scalars); arrays in
  flow form (\`tags: [a, b]\`).
- focus/summary/tags MAY be left empty — Previously's own housekeeping fills
  them in later (see "Semantic marking" below). Do NOT invent low-quality
  summaries just to fill them; empty beats wrong.

Dedup and conflicts: re-submitting identical content under the same
\`source\` + \`session_id\` is a no-op. Submitting DIFFERENT content under an
already-ingested \`source\` + \`session_id\` is a hard error — ingest never
overwrites; reconcile on your side or use a new session_id. If your slice_id
minute is already taken by another session, we step forward a minute and tell
you the remapped id.

Ingested slices are historical records: they never trigger card (前情提要)
evolution and get no per-slice card snapshot or cognition record.

## Semantic marking — OPTIONAL, spends tokens

Dry slices (no focus/summary) are usable as-is: the Previously kernel
backfills focus/summary lazily during normal operation, at no extra setup.
If the user wants the archive fully marked NOW (focus + summary + tags /
线索), run:

    previously ingest --mark            # prints the estimate: N slices → N calls, no spending
    previously ingest --mark --yes      # confirms THIS batch and spends

One confirmation covers one batch. Always show the user the estimate and get
their go-ahead before re-running with --yes.

## Card bootstrap — OPTIONAL, spends tokens

After importing history, the "Previously On" card (前情提要) can be seeded
from the archive instead of starting blank:

    previously card bootstrap --empty            # zero cost: empty card, start fresh
    previously card bootstrap                    # estimate only: last 7 days of slices
    previously card bootstrap --yes              # 1 model call over the last 7 days
    previously card bootstrap --window 30d --yes # wider window
    previously card bootstrap --full             # estimate for the ENTIRE history
    previously card bootstrap --full --yes       # long, token-heavy — warn the user

Default recommendation: the 7-day window. History older than that rarely
belongs in "Now". \`--full\` is available for completeness but needs an
explicit warning: it is one long model call over everything.
`;

const SETUP_DOC_TEMPLATE = `# Previously Setup

The user asked you to set up Previously on this machine. This walkthrough is
the whole job. Every step is a \`previously\` CLI command; run them in order
and check each result before moving on. Steps marked **TOKEN** spend the
user's subscription tokens — always tell the user what will be spent and get
their confirmation first (the commands themselves also refuse to spend
without \`--yes\`).

## 0. Check the current state

    previously status

Not initialized → continue. Already initialized and running → skip to step 3
or just report the state to the user.

## 1. Initialize (no token cost)

    previously init --non-interactive --backend <claude|codex|kimi>

Pick the agent CLI the user actually has a subscription for (the one you are
running on is a good default — ask if unsure). This one command creates
~/.previously, writes the config, AND transcribes all existing agent history
into time slices — pure local processing, safe to run fully. Always pass
\`--non-interactive\` (without it a TTY launches the human wizard, which will
block you); add \`--json\` if you want a machine-readable summary.
For a human at a terminal, bare \`previously\` runs the interactive wizard;
once initialized, bare \`previously\` shows the status dashboard.

Useful variants: \`--skip-ingest\` (layout/config only), \`--rebuild\`
(discard the transcribed slices and re-transcribe from the raw logs, e.g.
after a transcription-format upgrade), \`--memory-root <path>\` (custom
memory location).

## 2. Start the kernel (no token cost)

    previously start

Starts the local kernel + the scribe (the watcher that transcribes this
machine's agent session logs into memory from now on). \`previously open\`
opens the Web UI.

## 3. Supplemental imports (no token cost)

    previously ingest --source claude-code
    previously ingest --source codex
    previously ingest --source kimi-code
    previously ingest --source gemini

Only needed for sources init did not see: a newly installed agent CLI, or log
files copied from another machine (drop them under the agent's usual log root
first). Skip sources whose root is absent.

## 4. OPTIONAL: mark the archive (**TOKEN**)

    previously ingest --mark          # estimate first — show it to the user
    previously ingest --mark --yes    # only after the user confirms

Fills focus/summary/tags (线索) for imported slices: one model call per dry
slice. Skipping this is fine — the kernel backfills focus/summary gradually
during normal use; only tags stay empty.

## 5. OPTIONAL: bootstrap the 前情提要 card (**TOKEN**)

    previously card bootstrap         # estimate first — show it to the user
    previously card bootstrap --yes   # last 7 days, one model call

Alternatives: \`--empty\` (zero cost, start fresh), \`--full --yes\` (whole
history — warn the user it is one long, token-heavy call).

## Reporting back

Tell the user: what state Previously was in, what you did, what you skipped
and why, and any step that failed with the exact error. Never claim a step
worked without checking its output.
`;

/** Render the canonical memory document with an absolute memory root filled in. */
export function renderSkillDoc(memoryRoot: string): string {
  return SKILL_DOC_TEMPLATE.split(MEMORY_ROOT_PLACEHOLDER).join(memoryRoot);
}

export interface SkillGroupFile {
  /** File name inside the skill dir. */
  name: string;
  content: string;
}

/**
 * The full skill group, rendered for one memory root. File order is the
 * display order (SKILL.md first).
 */
export function renderSkillGroup(memoryRoot: string): SkillGroupFile[] {
  const fill = (doc: string): string => doc.split(MEMORY_ROOT_PLACEHOLDER).join(memoryRoot);
  return [
    {
      name: 'SKILL.md',
      content: [
        '---',
        `name: ${SKILL_NAME}`,
        'description: Access the user\'s Previously long-term memory (read), contribute conversations to it (write via `previously ingest`), and bootstrap the local Previously setup. Recall from memory before answering anything about the user\'s past.',
        '---',
        '',
        fill(OVERVIEW_DOC_TEMPLATE),
      ].join('\n'),
    },
    { name: 'memory.md', content: renderSkillDoc(memoryRoot) },
    { name: 'ingest.md', content: fill(INGEST_DOC_TEMPLATE) },
    { name: 'setup.md', content: SETUP_DOC_TEMPLATE },
  ];
}

/** Sentinel markers delimiting the block we own inside a shared file. */
export const SENTINEL_START = '<!-- previously:memory:start -->';
export const SENTINEL_END = '<!-- previously:memory:end -->';

/**
 * The exact block we own in a shared instructions file (codex AGENTS.md):
 * the whole skill group concatenated (single-file channel).
 */
export function sentinelBlock(memoryRoot: string): string {
  const body = renderSkillGroup(memoryRoot)
    .map((file) => {
      // SKILL.md's YAML frontmatter is meaningless inside a shared markdown
      // file — drop it, keep the body.
      const content = file.name === 'SKILL.md' ? file.content.replace(/^---\n[\s\S]*?\n---\n\n/, '') : file.content;
      return content.trimEnd();
    })
    .join('\n\n---\n\n');
  return `${SENTINEL_START}\n${body}\n${SENTINEL_END}`;
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

/** User-level skill DIR per owned-target agent (home is injectable for tests). */
export function userSkillDir(agent: BridgeAgent, home: string = homedir()): string {
  switch (agent) {
    case 'claude':
      return join(home, '.claude', 'skills', SKILL_NAME);
    case 'kimi':
      return join(home, '.kimi', 'skills', SKILL_NAME);
    default:
      throw new Error(`${agent} has no owned skill dir (shared-file target)`);
  }
}

/** The pre-group single-file skill location, cleaned up on install. */
function legacySkillDir(agent: BridgeAgent, home: string): string {
  switch (agent) {
    case 'claude':
      return join(home, '.claude', 'skills', LEGACY_SKILL_NAME);
    case 'kimi':
      return join(home, '.kimi', 'skills', LEGACY_SKILL_NAME);
    default:
      throw new Error(`${agent} has no legacy skill dir`);
  }
}

/** The shared-file target (codex global AGENTS.md). */
export function userSharedFilePath(agent: BridgeAgent, home: string = homedir()): string {
  if (agent !== 'codex') throw new Error(`${agent} has an owned skill dir, not a shared file`);
  return join(home, '.codex', 'AGENTS.md');
}

/**
 * True when the agent's user-level target is a directory we own outright
 * (a skill dir) rather than a shared file needing sentinels.
 */
export function ownsSkillDir(agent: BridgeAgent): boolean {
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

function fileResult(
  target: BridgeAgent,
  path: string,
  action: SkillApplyResult['action'],
  backupPath: string | null,
  oldContent: string | null,
  newContent: string,
): SkillApplyResult {
  return { target, path, action, backupPath, oldContent, newContent };
}

/**
 * Legacy migration: the pre-group skill lived at skills/previously-memory/
 * with a single SKILL.md we wrote. Remove it when the dir holds exactly that
 * one file; when anything foreign sits inside, leave it alone and say so.
 */
function migrateLegacyDir(
  agent: BridgeAgent,
  home: string,
  dryRun: boolean,
): SkillApplyResult[] {
  const dir = legacySkillDir(agent, home);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  if (entries.length === 1 && entries[0] === 'SKILL.md') {
    const file = join(dir, 'SKILL.md');
    const oldContent = readFileSync(file, 'utf8');
    if (!dryRun) {
      rmSync(file, { force: true });
      removeDirIfEmpty(dir);
    }
    return [fileResult(agent, dir, 'removed', null, oldContent, '')];
  }
  console.error(`note: legacy skill dir ${dir} contains foreign files — left untouched`);
  return [];
}

/**
 * Compute and (unless dryRun) apply one agent's skill install
 * (mode 'install') or removal (mode 'uninstall'). Returns one result per
 * touched file/dir. Idempotent: converged targets report 'unchanged' and
 * write nothing.
 */
export function applySkillTarget(
  agent: BridgeAgent,
  mode: 'install' | 'uninstall',
  opts: ApplySkillOptions,
): SkillApplyResult[] {
  const home = opts.home ?? homedir();

  if (ownsSkillDir(agent)) {
    const dir = userSkillDir(agent, home);
    const results: SkillApplyResult[] = [];
    if (mode === 'install') {
      for (const file of renderSkillGroup(opts.memoryRoot)) {
        const path = join(dir, file.name);
        const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (oldContent === file.content) {
          results.push(fileResult(agent, path, 'unchanged', null, oldContent, file.content));
          continue;
        }
        let backupPath: string | null = null;
        if (opts.dryRun !== true) {
          backupPath = backupOnce(path);
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, file.content, 'utf8');
        }
        results.push(fileResult(agent, path, 'installed', backupPath, oldContent, file.content));
      }
      results.push(...migrateLegacyDir(agent, home, opts.dryRun === true));
    } else {
      for (const name of ['SKILL.md', 'memory.md', 'ingest.md', 'setup.md']) {
        const path = join(dir, name);
        const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (oldContent === null) continue;
        if (opts.dryRun !== true) rmSync(path, { force: true });
        results.push(fileResult(agent, path, 'removed', null, oldContent, ''));
      }
      if (opts.dryRun !== true) removeDirIfEmpty(dir);
      results.push(...migrateLegacyDir(agent, home, opts.dryRun === true));
    }
    return results;
  }

  // Shared file (codex global AGENTS.md): sentinel-delimited block.
  const path = userSharedFilePath(agent, home);
  const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const newContent = mergeSentinelBlock(
    oldContent,
    mode === 'install' ? sentinelBlock(opts.memoryRoot) : null,
  );
  if (newContent === (oldContent ?? '') && oldContent !== null) {
    return [fileResult(agent, path, 'unchanged', null, oldContent, newContent)];
  }
  if (oldContent === null && mode === 'uninstall') {
    return [fileResult(agent, path, 'unchanged', null, oldContent, '')];
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
  return [
    fileResult(agent, path, mode === 'install' ? 'installed' : 'removed', backupPath, oldContent, newContent),
  ];
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
 * caller owns cleanup (rm -rf the dir in a finally block). `doc` overrides
 * the document written (phase outsourcing); absent = the generic doc.
 */
export function materializeBridgeWorkspace(
  agent: BridgeAgent,
  memoryRoot: string,
  doc?: string,
): BridgeWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'previously-bridge-'));
  const filePath = join(dir, workspaceFileName(agent));
  try {
    writeFileSync(filePath, doc ?? renderSkillDoc(memoryRoot), 'utf8');
  } catch (err) {
    // Don't leak the just-created temp dir when the write itself fails.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — the OS temp cleaner gets it
    }
    throw err;
  }
  return { dir, filePath };
}
