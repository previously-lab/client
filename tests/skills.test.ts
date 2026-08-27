import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySkillTarget,
  materializeBridgeWorkspace,
  mergeSentinelBlock,
  MEMORY_ROOT_PLACEHOLDER,
  ownsSkillDir,
  renderSkillDoc,
  renderSkillGroup,
  SENTINEL_END,
  SENTINEL_START,
  sentinelBlock,
  sweepStaleBridgeWorkspaces,
  userSharedFilePath,
  userSkillDir,
  workspaceFileName,
} from '../src/lib/skills.js';

/** Sandboxed user home for skill files — never the real one. */
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'previously-skills-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const ROOT = 'C:\\mem\\root';
/** The skill group's four documents, in display order. */
const GROUP_FILES = ['SKILL.md', 'memory.md', 'ingest.md', 'setup.md'];

describe('renderSkillDoc', () => {
  it('fills the MEMORY_ROOT placeholder and leaves none behind', () => {
    const doc = renderSkillDoc(ROOT);
    expect(doc).not.toContain(MEMORY_ROOT_PLACEHOLDER);
    expect(doc).toContain(ROOT);
  });

  it('documents the real on-disk memory layout', () => {
    const doc = renderSkillDoc(ROOT);
    expect(doc).toContain('episodic/timeline.md');
    expect(doc).toContain('episodic/timeline/index.json');
    expect(doc).toContain('episodic/strands.json');
    expect(doc).toContain('episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md');
    expect(doc).toContain('YYYY-MM-DD-HHMM');
    expect(doc).toContain('_index.json');
  });

  it('states the read-only rule and the verbatim-reply output contract', () => {
    const doc = renderSkillDoc(ROOT);
    expect(doc).toContain('READ-ONLY');
    expect(doc).toContain('rendered verbatim');
  });
});

describe('renderSkillGroup (the four-document skill pack)', () => {
  it('renders SKILL.md + memory.md + ingest.md + setup.md in display order', () => {
    const group = renderSkillGroup(ROOT);
    expect(group.map((f) => f.name)).toEqual(GROUP_FILES);
  });

  it('SKILL.md carries name/description frontmatter for the "previously" skill', () => {
    const skill = renderSkillGroup(ROOT)[0]!;
    expect(skill.content.startsWith('---\nname: previously\n')).toBe(true);
    expect(skill.content).toContain('description:');
  });

  it('memory.md is byte-identical to renderSkillDoc; placeholders filled everywhere', () => {
    const group = renderSkillGroup(ROOT);
    expect(group[1]!.content).toBe(renderSkillDoc(ROOT));
    expect(group[2]!.content).toContain(ROOT); // ingest.md carries the memory root
    for (const file of group) {
      expect(file.content).not.toContain(MEMORY_ROOT_PLACEHOLDER);
    }
  });
});

describe('sentinelBlock (single-file channel)', () => {
  it('concatenates all four documents between the sentinels', () => {
    const block = sentinelBlock(ROOT);
    expect(block.startsWith(SENTINEL_START)).toBe(true);
    expect(block.endsWith(SENTINEL_END)).toBe(true);
    expect(block).toContain(renderSkillDoc(ROOT).trimEnd());
    expect(block).toContain('# Previously Ingest (write access)');
    expect(block).toContain('# Previously Setup');
    expect(block).not.toContain(MEMORY_ROOT_PLACEHOLDER);
  });

  it('strips SKILL.md’s YAML frontmatter (meaningless inside a shared file)', () => {
    const block = sentinelBlock(ROOT);
    expect(block).not.toContain('name: previously');
    expect(block).toContain('# Previously\n');
  });
});

describe('per-agent format selection', () => {
  it('maps agents to their user-level install targets', () => {
    expect(userSkillDir('claude', home)).toBe(join(home, '.claude', 'skills', 'previously'));
    expect(userSkillDir('kimi', home)).toBe(join(home, '.kimi', 'skills', 'previously'));
    expect(userSharedFilePath('codex', home)).toBe(join(home, '.codex', 'AGENTS.md'));
  });

  it('claude/kimi own a skill dir; codex writes a shared file', () => {
    expect(ownsSkillDir('claude')).toBe(true);
    expect(ownsSkillDir('kimi')).toBe(true);
    expect(ownsSkillDir('codex')).toBe(false);
  });

  it('maps agents to their cwd-convention workspace file', () => {
    expect(workspaceFileName('claude')).toBe('CLAUDE.md');
    expect(workspaceFileName('codex')).toBe('AGENTS.md');
    expect(workspaceFileName('kimi')).toBe('AGENTS.md');
  });
});

describe('mergeSentinelBlock (shared-file sentinel append)', () => {
  const block = sentinelBlock(ROOT);

  it('creates the block in an empty/absent file', () => {
    const merged = mergeSentinelBlock(null, block);
    expect(merged).toBe(block + '\n');
  });

  it('appends after foreign content, preserving it byte-for-byte', () => {
    const existing = '# My global instructions\n\nAlways be terse.\n';
    const merged = mergeSentinelBlock(existing, block);
    expect(merged.startsWith(existing.trimEnd())).toBe(true);
    expect(merged).toContain(SENTINEL_START);
    expect(merged).toContain(SENTINEL_END);
  });

  it('replaces an existing block in place (idempotent re-run)', () => {
    const existing = `# Header\n\n${sentinelBlock('/old/root')}\n\n# Footer\n`;
    const once = mergeSentinelBlock(existing, block);
    expect(once).toContain('# Header');
    expect(once).toContain('# Footer');
    expect(once).toContain(ROOT);
    expect(once).not.toContain('/old/root');
    expect(mergeSentinelBlock(once, block)).toBe(once);
  });

  it('removal restores the original foreign content exactly', () => {
    const foreign = '# My global instructions\n\nAlways be terse.\n';
    const withBlock = mergeSentinelBlock(foreign, block);
    expect(mergeSentinelBlock(withBlock, null)).toBe(foreign);
  });

  it('removal of the only block empties the file', () => {
    const withBlock = mergeSentinelBlock(null, block);
    expect(mergeSentinelBlock(withBlock, null)).toBe('');
  });
});

describe('applySkillTarget', () => {
  it('claude: install writes the four-file skill dir, re-run is unchanged, uninstall removes it', () => {
    const dir = userSkillDir('claude', home);

    const first = applySkillTarget('claude', 'install', { home, memoryRoot: ROOT });
    expect(first.map((r) => [basename(r.path), r.action])).toEqual(GROUP_FILES.map((f) => [f, 'installed']));
    const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: previously');
    expect(readFileSync(join(dir, 'memory.md'), 'utf8')).toBe(renderSkillDoc(ROOT));
    expect(readFileSync(join(dir, 'ingest.md'), 'utf8')).toContain(ROOT);

    const second = applySkillTarget('claude', 'install', { home, memoryRoot: ROOT });
    expect(second.length).toBe(4);
    expect(second.every((r) => r.action === 'unchanged')).toBe(true);

    const removed = applySkillTarget('claude', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed.map((r) => r.action)).toEqual(['removed', 'removed', 'removed', 'removed']);
    expect(existsSync(dir)).toBe(false);
    // The owned skill dir is removed too when empty.
    expect(existsSync(join(home, '.claude', 'skills', 'previously'))).toBe(false);

    const again = applySkillTarget('claude', 'uninstall', { home, memoryRoot: ROOT });
    expect(again).toEqual([]);
  });

  it('codex: sentinel block appended to a shared AGENTS.md, uninstall restores it', () => {
    const path = userSharedFilePath('codex', home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    const foreign = '# User rules\n\nBe terse.\n';
    writeFileSync(path, foreign, 'utf8');

    const first = applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(first.length).toBe(1);
    expect(first[0]!.action).toBe('installed');
    const content = readFileSync(path, 'utf8');
    expect(content.startsWith(foreign.trimEnd())).toBe(true);
    expect(content).toContain(SENTINEL_START);
    expect(content).toContain(ROOT);
    // A pre-existing file is backed up once before the first modification.
    expect(first[0]!.backupPath).toBe(`${path}.bak`);

    const second = applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(second[0]!.action).toBe('unchanged');

    const removed = applySkillTarget('codex', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed[0]!.action).toBe('removed');
    // The .bak from the first install is never overwritten by later writes.
    expect(removed[0]!.backupPath).toBeNull();
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(foreign);
    expect(readFileSync(path, 'utf8')).toBe(foreign);
  });

  it('codex: uninstall of a file holding only our block deletes the file', () => {
    const path = userSharedFilePath('codex', home);
    applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(existsSync(path)).toBe(true);
    const removed = applySkillTarget('codex', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed[0]!.action).toBe('removed');
    expect(existsSync(path)).toBe(false);
  });

  it('dry-run computes the results but writes nothing', () => {
    const dir = userSkillDir('kimi', home);
    const results = applySkillTarget('kimi', 'install', { home, memoryRoot: ROOT, dryRun: true });
    expect(results.length).toBe(4);
    expect(results.every((r) => r.action === 'installed')).toBe(true);
    expect(results.every((r) => r.newContent.length > 0)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('migration: a legacy previously-memory dir holding only our SKILL.md is removed', () => {
    const legacy = join(home, '.claude', 'skills', 'previously-memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'old skill bytes', 'utf8');

    const results = applySkillTarget('claude', 'install', { home, memoryRoot: ROOT });
    const migration = results.find((r) => r.path === legacy);
    expect(migration?.action).toBe('removed');
    expect(migration?.oldContent).toBe('old skill bytes');
    expect(existsSync(legacy)).toBe(false);
    // The new group was installed alongside the migration.
    expect(readFileSync(join(userSkillDir('claude', home), 'SKILL.md'), 'utf8')).toContain('name: previously');
  });

  it('migration: a legacy dir with foreign files is left untouched (with a stderr note)', () => {
    const legacy = join(home, '.kimi', 'skills', 'previously-memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'old skill bytes', 'utf8');
    writeFileSync(join(legacy, 'notes.txt'), 'foreign', 'utf8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = applySkillTarget('kimi', 'install', { home, memoryRoot: ROOT });
      expect(results.some((r) => r.path === legacy)).toBe(false);
      expect(readFileSync(join(legacy, 'SKILL.md'), 'utf8')).toBe('old skill bytes');
      expect(readFileSync(join(legacy, 'notes.txt'), 'utf8')).toBe('foreign');
      expect(errSpy.mock.calls.join('\n')).toContain('foreign files');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('materializeBridgeWorkspace', () => {
  it('writes the agent cwd file with MEMORY_ROOT filled; caller cleanup works', () => {
    const ws = materializeBridgeWorkspace('claude', ROOT);
    try {
      expect(ws.filePath).toBe(join(ws.dir, 'CLAUDE.md'));
      const content = readFileSync(ws.filePath, 'utf8');
      expect(content).toContain(ROOT);
      expect(content).not.toContain(MEMORY_ROOT_PLACEHOLDER);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('codex and kimi get AGENTS.md', () => {
    for (const agent of ['codex', 'kimi'] as const) {
      const ws = materializeBridgeWorkspace(agent, ROOT);
      expect(ws.filePath).toBe(join(ws.dir, 'AGENTS.md'));
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  it('payload skills are written as skills/<name>.md with placeholders filled', () => {
    const ws = materializeBridgeWorkspace('claude', ROOT, undefined, {
      skills: { recall: 'Run `{{PREVIOUSLY_CMD}} timeline` under {{MEMORY_ROOT}}.\n' },
      previouslyCmd: '"node" "C:\\x\\cli.js"',
    });
    try {
      const skill = readFileSync(join(ws.dir, 'skills', 'recall.md'), 'utf8');
      expect(skill).toBe('Run `"node" "C:\\x\\cli.js" timeline` under ' + ROOT + '.\n');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  it('no skills option → no skills directory; invalid skill names are refused', () => {
    const ws = materializeBridgeWorkspace('claude', ROOT);
    try {
      expect(existsSync(join(ws.dir, 'skills'))).toBe(false);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
    expect(() =>
      materializeBridgeWorkspace('claude', ROOT, undefined, { skills: { '../evil': 'x' } }),
    ).toThrow(/Invalid skill name/);
  });
});

describe('sweepStaleBridgeWorkspaces', () => {
  // Hard-killed bridge-exec processes (TerminateProcess runs no finally)
  // leave their workspace behind; the sweep collects them next call.
  it('removes stale workspaces, keeps fresh ones, ignores foreign dirs', () => {
    const tag = `sweep-${process.pid}`;
    const stale = join(tmpdir(), `previously-bridge-${tag}-old`);
    const fresh = join(tmpdir(), `previously-bridge-${tag}-new`);
    const foreign = join(tmpdir(), `unrelated-${tag}`);
    for (const dir of [stale, fresh, foreign]) mkdirSync(dir, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    utimesSync(foreign, twoDaysAgo, twoDaysAgo);
    try {
      sweepStaleBridgeWorkspaces();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      for (const dir of [stale, fresh, foreign]) rmSync(dir, { recursive: true, force: true });
    }
  });
});
