import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitAll, ensureMemoryRepo, repoSummary } from '../src/lib/memory-repo.js';
import { defaultMemoryRepo } from '../src/lib/paths.js';

/**
 * The memory-repo helpers run against plain temp dirs (no PREVIOUSLY_HOME
 * needed except for the defaultMemoryRepo sandbox rule, which is restored
 * after each test).
 */
describe('memory repo', () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'previously-repo-test-'));
    savedHome = process.env.PREVIOUSLY_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.PREVIOUSLY_HOME;
    else process.env.PREVIOUSLY_HOME = savedHome;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Leave leftovers for the OS temp cleaner (see helpers.cleanupTempHome).
    }
  });

  describe('defaultMemoryRepo', () => {
    it('prefers <Documents>/Previously when the Documents folder exists', () => {
      delete process.env.PREVIOUSLY_HOME;
      mkdirSync(join(dir, 'Documents'), { recursive: true });
      expect(defaultMemoryRepo(dir)).toBe(join(dir, 'Documents', 'Previously'));
    });

    it('falls back to <home>/Previously when there is no Documents folder', () => {
      delete process.env.PREVIOUSLY_HOME;
      expect(defaultMemoryRepo(dir)).toBe(join(dir, 'Previously'));
    });

    it('stays inside the PREVIOUSLY_HOME sandbox when it is set', () => {
      process.env.PREVIOUSLY_HOME = dir;
      expect(defaultMemoryRepo()).toBe(join(dir, 'memory'));
    });
  });

  describe('ensureMemoryRepo', () => {
    it('creates a repository (README + first commit) in a missing directory', async () => {
      const target = join(dir, 'fresh');
      const result = await ensureMemoryRepo(target);
      expect(result).toEqual({ ok: true, created: true, adopted: false });
      expect(existsSync(join(target, '.git'))).toBe(true);
      expect(existsSync(join(target, 'README.md'))).toBe(true);
      const summary = await repoSummary(target);
      expect(summary?.branch).toBe('main');
      expect(summary?.lastCommitAt).not.toBeNull();
      expect(summary?.uncommitted).toBe(0);
    });

    it('initializes an existing empty directory', async () => {
      const result = await ensureMemoryRepo(dir);
      expect(result).toEqual({ ok: true, created: true, adopted: false });
      expect(existsSync(join(dir, '.git'))).toBe(true);
    });

    it('adopts an existing Previously-like git repo (episodic/) without touching data', async () => {
      const target = join(dir, 'clone');
      await ensureMemoryRepo(target);
      // Simulate a repo cloned back from GitHub: committed Previously content.
      mkdirSync(join(target, 'episodic'), { recursive: true });
      writeFileSync(join(target, 'episodic', 'timeline.md'), '# Timeline\n', 'utf8');
      await commitAll(target, 'Previously content');

      const result = await ensureMemoryRepo(target);
      expect(result).toEqual({ ok: true, created: false, adopted: true });
      // Untouched: content still there, still committed-clean.
      expect((await repoSummary(target))?.uncommitted).toBe(0);
    });

    it('adopts a git repo with no commits yet (empty repository)', async () => {
      const target = join(dir, 'empty-repo');
      mkdirSync(target, { recursive: true });
      const { default: git } = await import('isomorphic-git');
      const fs = await import('node:fs');
      await git.init({ fs, dir: target, defaultBranch: 'main' });
      const result = await ensureMemoryRepo(target);
      expect(result).toEqual({ ok: true, created: false, adopted: true });
    });

    it('refuses a non-empty non-git directory and never initializes over it', async () => {
      writeFileSync(join(dir, 'precious.txt'), 'do not touch\n', 'utf8');
      const result = await ensureMemoryRepo(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('refusing');
      expect(existsSync(join(dir, '.git'))).toBe(false);
    });

    it('refuses a foreign git repo (commits, no episodic/) without touching it', async () => {
      const target = join(dir, 'foreign');
      mkdirSync(target, { recursive: true });
      const { default: git } = await import('isomorphic-git');
      const fs = await import('node:fs');
      await git.init({ fs, dir: target, defaultBranch: 'main' });
      writeFileSync(join(target, 'code.ts'), 'export {};\n', 'utf8');
      await git.add({ fs, dir: target, filepath: 'code.ts' });
      await git.commit({
        fs,
        dir: target,
        message: 'foreign project',
        author: { name: 'Someone', email: 'someone@example.com' },
      });
      const result = await ensureMemoryRepo(target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('does not look like a Previously memory repo');
    });
  });

  describe('commitAll', () => {
    it('commits worktree changes and reports clean on the next call', async () => {
      await ensureMemoryRepo(dir);
      writeFileSync(join(dir, 'note.md'), 'hello\n', 'utf8');
      expect(await commitAll(dir, 'test: add note')).toBe(true);
      expect((await repoSummary(dir))?.uncommitted).toBe(0);
      // Nothing to commit: still true, no new commit created.
      const before = (await repoSummary(dir))?.lastCommitAt;
      expect(await commitAll(dir, 'test: nothing')).toBe(true);
      expect((await repoSummary(dir))?.lastCommitAt).toBe(before);
    });

    it('stages deletions too', async () => {
      await ensureMemoryRepo(dir);
      writeFileSync(join(dir, 'gone.md'), 'x\n', 'utf8');
      await commitAll(dir, 'add');
      rmSync(join(dir, 'gone.md'));
      expect(await commitAll(dir, 'remove')).toBe(true);
      expect((await repoSummary(dir))?.uncommitted).toBe(0);
    });

    it('returns false quietly for a non-git directory', async () => {
      writeFileSync(join(dir, 'note.md'), 'hello\n', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await commitAll(dir, 'test')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns and returns false on failure instead of throwing', async () => {
      // A .git that is not a real repository makes statusMatrix throw.
      mkdirSync(join(dir, '.git'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await commitAll(dir, 'test')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('repoSummary', () => {
    it('returns null for a non-git directory', async () => {
      expect(await repoSummary(dir)).toBeNull();
    });

    it('caps the uncommitted count at 99+', async () => {
      await ensureMemoryRepo(dir);
      for (let i = 0; i < 105; i++) writeFileSync(join(dir, `f${i}.txt`), 'x\n', 'utf8');
      const summary = await repoSummary(dir);
      expect(summary?.uncommitted).toBe(100);
      expect(summary?.uncommittedCapped).toBe(true);
    });

    it('reports branch, clean tree, and last commit time on a healthy repo', async () => {
      await ensureMemoryRepo(dir);
      const summary = await repoSummary(dir);
      expect(summary).not.toBeNull();
      expect(summary?.branch).toBe('main');
      expect(summary?.uncommitted).toBe(0);
      expect(summary?.uncommittedCapped).toBe(false);
      expect(typeof summary?.lastCommitAt).toBe('string');
    });

    it('reports busy (not null) when the repo exists but its git state is unreadable', async () => {
      // A .git directory without HEAD/refs makes statusMatrix throw — the
      // summary must say "busy" rather than claiming it is not a git repo.
      mkdirSync(join(dir, '.git'), { recursive: true });
      const summary = await repoSummary(dir);
      expect(summary).not.toBeNull();
      expect(summary?.busy).toBe(true);
    });
  });

  describe('commit author', () => {
    it('defaults to Previously <previously@localhost> and honors env overrides', async () => {
      await ensureMemoryRepo(dir);
      const { default: git } = await import('isomorphic-git');
      const fs = await import('node:fs');
      let [commit] = await git.log({ fs, dir, depth: 1 });
      expect(commit?.commit.author.name).toBe('Previously');
      expect(commit?.commit.author.email).toBe('previously@localhost');

      process.env.PREVIOUSLY_GIT_AUTHOR_NAME = 'Dream';
      process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL = 'dream@example.com';
      try {
        writeFileSync(join(dir, 'note.md'), 'x\n', 'utf8');
        await commitAll(dir, 'custom author');
        [commit] = await git.log({ fs, dir, depth: 1 });
        expect(commit?.commit.author.name).toBe('Dream');
        expect(commit?.commit.author.email).toBe('dream@example.com');
      } finally {
        delete process.env.PREVIOUSLY_GIT_AUTHOR_NAME;
        delete process.env.PREVIOUSLY_GIT_AUTHOR_EMAIL;
      }
    });
  });
});
