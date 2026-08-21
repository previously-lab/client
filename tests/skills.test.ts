import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySkillTarget,
  materializeBridgeWorkspace,
  mergeSentinelBlock,
  MEMORY_ROOT_PLACEHOLDER,
  renderSkillDoc,
  renderSkillFile,
  SENTINEL_END,
  SENTINEL_START,
  sentinelBlock,
  userSkillPath,
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

describe('renderSkillFile (claude / kimi SKILL.md form)', () => {
  it('carries name + description frontmatter before the document', () => {
    const file = renderSkillFile(ROOT);
    expect(file.startsWith('---\nname: previously-memory\n')).toBe(true);
    expect(file).toContain('description:');
    expect(file).toContain(ROOT);
  });
});

describe('per-agent format selection', () => {
  it('maps agents to their user-level install paths', () => {
    expect(userSkillPath('claude', home)).toBe(join(home, '.claude', 'skills', 'previously-memory', 'SKILL.md'));
    expect(userSkillPath('kimi', home)).toBe(join(home, '.kimi', 'skills', 'previously-memory', 'SKILL.md'));
    expect(userSkillPath('codex', home)).toBe(join(home, '.codex', 'AGENTS.md'));
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
  it('claude: install writes SKILL.md, re-run is unchanged, uninstall removes it', () => {
    const path = userSkillPath('claude', home);

    const first = applySkillTarget('claude', 'install', { home, memoryRoot: ROOT });
    expect(first.action).toBe('installed');
    expect(readFileSync(path, 'utf8')).toContain('name: previously-memory');
    expect(readFileSync(path, 'utf8')).toContain(ROOT);

    const second = applySkillTarget('claude', 'install', { home, memoryRoot: ROOT });
    expect(second.action).toBe('unchanged');

    const removed = applySkillTarget('claude', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed.action).toBe('removed');
    expect(existsSync(path)).toBe(false);
    // The owned skill dir is removed too when empty.
    expect(existsSync(join(home, '.claude', 'skills', 'previously-memory'))).toBe(false);

    const again = applySkillTarget('claude', 'uninstall', { home, memoryRoot: ROOT });
    expect(again.action).toBe('unchanged');
  });

  it('codex: sentinel block appended to a shared AGENTS.md, uninstall restores it', () => {
    const path = userSkillPath('codex', home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    const foreign = '# User rules\n\nBe terse.\n';
    writeFileSync(path, foreign, 'utf8');

    const first = applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(first.action).toBe('installed');
    const content = readFileSync(path, 'utf8');
    expect(content.startsWith(foreign.trimEnd())).toBe(true);
    expect(content).toContain(SENTINEL_START);
    expect(content).toContain(ROOT);
    // A pre-existing file is backed up once before the first modification.
    expect(first.backupPath).toBe(`${path}.bak`);

    const second = applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(second.action).toBe('unchanged');

    const removed = applySkillTarget('codex', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed.action).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe(foreign);
  });

  it('codex: uninstall of a file holding only our block deletes the file', () => {
    const path = userSkillPath('codex', home);
    applySkillTarget('codex', 'install', { home, memoryRoot: ROOT });
    expect(existsSync(path)).toBe(true);
    const removed = applySkillTarget('codex', 'uninstall', { home, memoryRoot: ROOT });
    expect(removed.action).toBe('removed');
    expect(existsSync(path)).toBe(false);
  });

  it('dry-run computes the result but writes nothing', () => {
    const path = userSkillPath('kimi', home);
    const res = applySkillTarget('kimi', 'install', { home, memoryRoot: ROOT, dryRun: true });
    expect(res.action).toBe('installed');
    expect(res.newContent).toContain(ROOT);
    expect(existsSync(path)).toBe(false);
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
});
