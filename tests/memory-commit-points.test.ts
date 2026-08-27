import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as ingestRun } from '../src/commands/ingest.js';
import { runScribe } from '../src/commands/scribe.js';
import { run as stop } from '../src/commands/stop.js';
import { commitAll } from '../src/lib/memory-repo.js';
import type { ScribeRoots } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import { claudeUserLine, makeFakeAgentHome, writeClaudeSession } from './scribe-fixtures.js';

/**
 * The commit rhythm: scribe scans, ingest modes, and `stop`'s sweep all land
 * their batches via commitAll — and a commit failure never blocks the command.
 * commitAll itself is mocked (its real behavior is covered in
 * memory-repo.test.ts); the rest of memory-repo stays real.
 */
vi.mock('../src/lib/memory-repo.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/memory-repo.js')>();
  return { ...original, commitAll: vi.fn().mockResolvedValue(true) };
});

const commitAllMock = vi.mocked(commitAll);

describe('memory repo commit points', () => {
  let home: string;
  let roots: ScribeRoots;

  beforeEach(() => {
    home = useTempHome();
    roots = makeFakeAgentHome(join(home, 'fakehome'));
    commitAllMock.mockClear().mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  function writeOneClaudeSession(): void {
    writeClaudeSession(roots, 'sess-a', [
      claudeUserLine('提交测试', '2026-08-10T14:01:00.000Z', 'sess-a'),
    ]);
  }

  it('scribe once commits the batch after the scan', async () => {
    writeOneClaudeSession();
    expect(await runScribe(['once'], { roots })).toBe(0);
    expect(commitAllMock).toHaveBeenCalledWith(
      join(home, 'memory'),
      expect.stringMatching(/^Scribe: 1 slice\(s\) from claude-code$/),
    );
  });

  it('a failed scribe commit warns (inside commitAll) but never fails the scan', async () => {
    writeOneClaudeSession();
    commitAllMock.mockResolvedValue(false);
    expect(await runScribe(['once'], { roots })).toBe(0);
    expect(commitAllMock).toHaveBeenCalled();
  });

  it('scribe once commits nothing when no slices were written', async () => {
    expect(await runScribe(['once'], { roots })).toBe(0);
    expect(commitAllMock).not.toHaveBeenCalled();
  });

  it('ingest --source commits the landed slices', async () => {
    writeOneClaudeSession();
    expect(await ingestRun(['--source', 'claude-code', '--root', roots['claude-code']])).toBe(0);
    expect(commitAllMock).toHaveBeenCalledWith(
      join(home, 'memory'),
      expect.stringMatching(/^Ingest: 1 slice\(s\) from claude-code$/),
    );
  });

  it('previously stop sweeps uncommitted changes after stopping', async () => {
    // Nothing running — the sweep still happens (it is the safety net).
    expect(await stop([], { graceTimeoutMs: 100 })).toBe(0);
    expect(commitAllMock).toHaveBeenCalledWith(join(home, 'memory'), 'Sweep: uncommitted changes');
  });
});
