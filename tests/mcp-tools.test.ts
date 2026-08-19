import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryError, listStrands, readSlice, readStrand, readTimeline, searchMemory } from '../src/lib/memory.js';
import { handleMessage, type McpContext } from '../src/mcp/protocol.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('memory read tools', () => {
  let home: string;
  let memory: string;

  beforeEach(() => {
    home = useTempHome();
    memory = writeFixtureMemory(home);
  });

  afterEach(() => {
    cleanupTempHome(home);
  });

  describe('readTimeline', () => {
    it('returns the full timeline without a filter', () => {
      const text = readTimeline(memory);
      expect(text).toContain('# Timeline');
      expect(text).toContain('2026-08-10-1401');
      expect(text).toContain('2026-07-28-0658');
    });

    it('filters by month', () => {
      const text = readTimeline(memory, { month: '2026-08' });
      expect(text).toContain('2026-08-10-1401');
      expect(text).not.toContain('2026-07-28-0658');
    });

    it('filters by month and day', () => {
      const text = readTimeline(memory, { month: '2026-08', day: '08-09' });
      expect(text).toContain('2026-08-09-1546');
      expect(text).not.toContain('2026-08-10-1401');
    });

    it('reports honestly when the filter matches nothing', () => {
      expect(() => readTimeline(memory, { month: '2025-01' })).toThrowError(/No timeline entries match/);
    });

    it('rejects malformed filter values', () => {
      expect(() => readTimeline(memory, { month: '../..' })).toThrowError(MemoryError);
      expect(() => readTimeline(memory, { day: '8-9' })).toThrowError(MemoryError);
    });

    it('falls back to timeline/index.json when timeline.md is absent', () => {
      rmSync(`${memory}/episodic/timeline.md`);
      const text = readTimeline(memory);
      expect(text).toContain('"_schema": 1');
    });

    it('errors honestly when no timeline exists at all', () => {
      rmSync(`${memory}/episodic/timeline.md`);
      rmSync(`${memory}/episodic/timeline`, { recursive: true });
      expect(() => readTimeline(memory)).toThrowError(/No timeline found/);
    });
  });

  describe('readSlice', () => {
    it('reads the slice conversation record', () => {
      const text = readSlice(memory, '2026-08-10-1401');
      expect(text).toContain('slice_id: 2026-08-10-1401');
      expect(text).toContain('Apex Intelligence 的面试');
    });

    it('applies a 1-based inclusive line range', () => {
      const text = readSlice(memory, '2026-08-10-1401', { startLine: 1, endLine: 2 });
      expect(text).toBe('---\nslice_id: 2026-08-10-1401\n');
    });

    it('rejects traversal-shaped and malformed ids strictly', () => {
      for (const bad of [
        '../../..',
        '../../../etc/passwd',
        '..\\..\\windows',
        '2026-08-10-1401/../../x',
        '2026-8-10-1401',
        '2026-13-10-1401',
        '2026-08-32-1401',
        '2026-08-10-2501',
        '2026-08-10-1461',
        '',
        'x',
      ]) {
        expect(() => readSlice(memory, bad), bad).toThrowError(/Invalid slice id/);
      }
    });

    it('reports honestly when the slice file is missing', () => {
      expect(() => readSlice(memory, '2026-08-11-0900')).toThrowError(/No slice found/);
    });

    it('rejects a backwards line range', () => {
      expect(() => readSlice(memory, '2026-08-10-1401', { startLine: 5, endLine: 2 })).toThrowError(
        /Invalid line range/,
      );
    });
  });

  describe('strands', () => {
    it('lists strands sorted by name', () => {
      const strands = listStrands(memory);
      expect(strands).toEqual([
        { name: '面试准备', sliceCount: 1 },
        { name: '项目开发', sliceCount: 2 },
      ]);
    });

    it('reads one strand', () => {
      expect(readStrand(memory, '面试准备')).toEqual({ name: '面试准备', slices: ['2026/08/10/1401'] });
    });

    it('errors with the available names for an unknown strand', () => {
      expect(() => readStrand(memory, '不存在的线索')).toThrowError(/Available strands/);
    });
  });

  describe('searchMemory', () => {
    it('finds case-insensitive substring matches in slice files', () => {
      const result = searchMemory(memory, 'apex intelligence');
      expect(result.matchCount).toBeGreaterThanOrEqual(2); // core.md + _index.json
      expect(result.truncated).toBe(false);
      for (const m of result.matches) {
        expect(m.path.startsWith('episodic/slices/')).toBe(true);
        expect(m.line).toBeGreaterThan(0);
      }
    });

    it('matches tags through the monthly _index.json manifests', () => {
      const result = searchMemory(memory, '自我进化');
      expect(result.matches.some((m) => m.path.endsWith('_index.json'))).toBe(true);
    });

    it('rejects an empty query', () => {
      expect(() => searchMemory(memory, '  ')).toThrowError(/non-empty/);
    });

    it('errors honestly when the slices directory is missing', () => {
      const empty = useTempHome();
      try {
        expect(() => searchMemory(`${empty}/memory`, 'x')).toThrowError(/No slices directory/);
      } finally {
        cleanupTempHome(empty);
        process.env.PREVIOUSLY_HOME = home;
      }
    });
  });
});

describe('tools/call error mapping', () => {
  let home: string;
  let ctx: McpContext;

  beforeEach(() => {
    home = useTempHome();
    ctx = { memoryRoot: writeFixtureMemory(home), serverInfo: { name: 'previously', version: '0.0.0-test' } };
  });

  afterEach(() => {
    cleanupTempHome(home);
  });

  function callTool(name: string, args: Record<string, unknown>) {
    return handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      ctx,
    )!;
  }

  it('happy path: read_slice returns content with isError false', () => {
    const res = callTool('read_slice', { sliceId: '2026-08-10-1401' });
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('Apex Intelligence');
  });

  it('tool execution failures are results with isError true (never protocol errors)', () => {
    const res = callTool('read_slice', { sliceId: '2026-01-01-0000' });
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(res.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not_found');
  });

  it('invalid slice ids surface as honest isError results, not fabricated content', () => {
    const res = callTool('read_slice', { sliceId: '../../../etc/passwd' });
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('invalid_id');
  });

  it('missing required arguments are JSON-RPC -32602', () => {
    const res = callTool('read_slice', {});
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain('sliceId');
  });
});
