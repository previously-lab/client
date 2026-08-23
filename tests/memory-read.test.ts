import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemoryError,
  readAgentTimeline,
  readCard,
  readSliceSummary,
} from '../src/lib/memory.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

describe('memory read tools (slicesummary / card / agentlog)', () => {
  let home: string;
  let memoryRoot: string;

  beforeEach(() => {
    home = useTempHome();
    memoryRoot = writeFixtureMemory(home);
  });
  afterEach(() => {
    cleanupTempHome(home);
  });

  describe('readSliceSummary', () => {
    it('returns ONLY the YAML frontmatter, never the body', () => {
      const summary = readSliceSummary(memoryRoot, '2026-08-10-1401');
      expect(summary).toBe(
        ['---', 'slice_id: 2026-08-10-1401', 'status: closed', 'tags: [面试, 自我进化]', '---', ''].join('\n'),
      );
      expect(summary).not.toContain('帮我准备');
    });

    it('missing slice → not_found', () => {
      expect(() => readSliceSummary(memoryRoot, '2026-08-11-0900')).toThrowError(MemoryError);
      try {
        readSliceSummary(memoryRoot, '2026-08-11-0900');
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    });

    it('malformed id → invalid_id (path traversal refused)', () => {
      try {
        readSliceSummary(memoryRoot, '../../etc/passwd');
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_id');
      }
    });

    it('core.md without frontmatter → invalid_data', () => {
      writeFileSync(
        join(memoryRoot, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md'),
        'no frontmatter here\n',
        'utf8',
      );
      try {
        readSliceSummary(memoryRoot, '2026-08-10-1401');
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_data');
      }
    });

    it('unterminated frontmatter → invalid_data', () => {
      writeFileSync(
        join(memoryRoot, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md'),
        '---\nslice_id: 2026-08-10-1401\nbody without closing fence\n',
        'utf8',
      );
      try {
        readSliceSummary(memoryRoot, '2026-08-10-1401');
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_data');
      }
    });
  });

  describe('readCard', () => {
    it('without a slice id, reads the live card', () => {
      const card = readCard(memoryRoot);
      expect(card).toContain('# Previously');
      expect(card).toContain('正在准备 Apex Intelligence 面试（周五）');
    });

    it('with a slice id, reads that slice’s card snapshot', () => {
      const card = readCard(memoryRoot, '2026-08-10-1401');
      expect(card).toContain('# Previously (snapshot @ 2026-08-10-1401)');
    });

    it('missing live card → not_found', () => {
      try {
        readCard(join(home, 'empty-memory'));
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    });

    it('slice without a snapshot → not_found', () => {
      try {
        readCard(memoryRoot, '2026-08-09-1546');
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    });
  });

  describe('readAgentTimeline', () => {
    it('reads the slice cognition record in full', () => {
      const log = readAgentTimeline(memoryRoot, '2026-08-10-1401');
      expect(log).toContain('# Agent Timeline — 2026-08-10-1401');
      expect(log).toContain('- proposed strand: 面试准备');
    });

    it('supports the same 1-based inclusive line range as readSlice', () => {
      const log = readAgentTimeline(memoryRoot, '2026-08-10-1401', { startLine: 3, endLine: 5 });
      expect(log).toBe(
        ['## Turn a1b2c3 (user)', '- classified intent: chat', '- recalled: 面试准备', ''].join('\n'),
      );
    });

    it('inverted range → invalid_args', () => {
      try {
        readAgentTimeline(memoryRoot, '2026-08-10-1401', { startLine: 5, endLine: 3 });
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_args');
      }
    });

    it('slice without an agent timeline → not_found', () => {
      try {
        readAgentTimeline(memoryRoot, '2026-08-09-1546');
        expect.unreachable();
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    });
  });
});
