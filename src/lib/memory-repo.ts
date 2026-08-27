import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';

/**
 * The memory directory is a local git repository. The client owns its
 * lifecycle: create/adopt at init, repair in the config doctor, and commit
 * after every write batch (scribe/ingest/stop sweep). Everything here is
 * best-effort — a missing or broken repo never crashes a command; failures
 * warn and report.
 *
 * isomorphic-git does the git work in-process, so no git binary is required
 * on the user's machine.
 */

export type EnsureMemoryRepoResult =
  | { ok: true; created: boolean; adopted: boolean }
  | { ok: false; reason: string };

export interface MemoryRepoSummary {
  /** Current branch; null when it cannot be resolved (e.g. detached HEAD). */
  branch: string | null;
  /** Uncommitted change count, capped at 100 (uncommittedCapped flags the cap). */
  uncommitted: number;
  /** True when the real uncommitted count exceeds the cap — display "99+". */
  uncommittedCapped: boolean;
  /** ISO timestamp of the latest commit; null when the repo has none yet. */
  lastCommitAt: string | null;
  /**
   * True when the repo exists but its git state could not be read right now
   * (e.g. another process is mid-commit). Distinct from "not a git repo"
   * (null return) so the status panel does not cry wolf on a transient race.
   */
  busy?: true;
}

const README_CONTENT = `# Previously memory

This directory is the local memory repository of Previously — your agents'
long-term memory, stored as time slices under \`episodic/\`.

It is a plain git repository: the client commits every change it lands, so
you can push it to a private GitHub repository for backup/sync:

    git remote add origin <your-private-repo-url>
    git push -u origin main
`;

/** Commit identity; overridable for users who want their own name on commits. */
function repoAuthor(): { name: string; email: string } {
  return {
    name: process.env.PREVIOUSLY_GIT_AUTHOR_NAME ?? 'Previously',
    email: process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL ?? 'previously@localhost',
  };
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** True when HEAD resolves — i.e. the repo has at least one commit. */
async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

/** Stage every worktree change (adds, modifications, deletions). Returns the count. */
async function stageAll(dir: string): Promise<number> {
  const matrix = await git.statusMatrix({ fs, dir });
  let changed = 0;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // untouched
    if (workdir === 0) await git.remove({ fs, dir, filepath });
    else await git.add({ fs, dir, filepath });
    changed++;
  }
  return changed;
}

/**
 * `git init` + README + initial commit inside an existing (or just-created)
 * directory. Exported for the config doctor's in-place repair of a memory
 * root that holds Previously content but no .git yet.
 */
export async function initializeRepo(
  dir: string,
  message = 'Initialize Previously memory repository',
): Promise<void> {
  await git.init({ fs, dir, defaultBranch: 'main' });
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) writeFileSync(readmePath, README_CONTENT, 'utf8');
  if ((await stageAll(dir)) > 0) {
    await git.commit({ fs, dir, message, author: repoAuthor() });
  }
}

/** True when README.md at the root is the one initializeRepo writes. */
function hasOurReadme(dir: string): boolean {
  try {
    return readFileSync(join(dir, 'README.md'), 'utf8').startsWith('# Previously memory');
  } catch {
    return false;
  }
}

/**
 * Make `dir` a Previously memory repository:
 *
 *   - missing or empty directory → create + git init + README + first commit
 *     ({ created: true });
 *   - an existing git repository that looks like a Previously memory repo
 *     (an episodic/ directory at the root, our README marker, or no commits
 *     yet) → adopt it as-is ({ adopted: true }); data is never rebuilt or
 *     touched — this is the "cloned back from GitHub" path;
 *   - anything else (non-empty, non-git, or a foreign git repo) →
 *     { ok: false, reason } — NEVER git-init over user data.
 */
export async function ensureMemoryRepo(dir: string): Promise<EnsureMemoryRepoResult> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    await initializeRepo(dir);
    return { ok: true, created: true, adopted: false };
  }
  if (!isGitRepo(dir)) {
    if (readdirSync(dir).length === 0) {
      await initializeRepo(dir);
      return { ok: true, created: true, adopted: false };
    }
    return {
      ok: false,
      reason:
        `${dir} exists, is not empty, and is not a git repository — ` +
        'refusing to initialize a repository over it. Move its contents aside or pick another memory root.',
    };
  }
  if (existsSync(join(dir, 'episodic')) || hasOurReadme(dir) || !(await hasCommits(dir))) {
    return { ok: true, created: false, adopted: true };
  }
  return {
    ok: false,
    reason:
      `${dir} is a git repository but does not look like a Previously memory repo ` +
      '(no episodic/ directory and it already has commits). Pick another memory root.',
  };
}

/**
 * Stage everything under the memory repo and commit. Resolves true when the
 * repo ends up clean (nothing to commit, or the commit landed); false when
 * the path is not a git repository (silent — non-repo memory roots are a
 * supported degraded state) or the commit failed (warned). Never throws.
 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  if (!isGitRepo(dir)) return false;
  try {
    if ((await stageAll(dir)) === 0) return true;
    await git.commit({ fs, dir, message, author: repoAuthor() });
    return true;
  } catch (err) {
    console.warn(`memory-repo: commit failed for ${dir}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Branch, uncommitted-change count (capped at 100 → "99+"), and last commit
 * time of the memory repo. Null when the path is not a (usable) git repo.
 */
export async function repoSummary(dir: string): Promise<MemoryRepoSummary | null> {
  if (!isGitRepo(dir)) return null;
  try {
    const branch = (await git.currentBranch({ fs, dir }).catch((): null => null)) ?? null;
    const matrix = await git.statusMatrix({ fs, dir });
    let uncommitted = 0;
    let uncommittedCapped = false;
    for (const [, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      uncommitted++;
      if (uncommitted >= 100) {
        uncommittedCapped = true;
        break;
      }
    }
    let lastCommitAt: string | null = null;
    try {
      const [latest] = await git.log({ fs, dir, depth: 1 });
      if (latest !== undefined) {
        lastCommitAt = new Date(latest.commit.committer.timestamp * 1000).toISOString();
      }
    } catch {
      // No commits yet — lastCommitAt stays null.
    }
    return { branch, uncommitted, uncommittedCapped, lastCommitAt };
  } catch {
    // The repo exists but its git state is unreadable right now (typically a
    // transient race with another process mid-commit) — say so honestly
    // instead of reporting "not a git repository".
    return { branch: null, uncommitted: 0, uncommittedCapped: false, lastCommitAt: null, busy: true };
  }
}
