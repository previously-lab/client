import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePaths } from '../src/lib/paths.js';
import { CursorStore } from '../src/scribe/cursor.js';
import { ScribeEngine, ScribeWatcher } from '../src/scribe/watcher.js';
import type { ScribeRoots } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import {
  claudeAssistantLine,
  claudeUserLine,
  geminiChatDoc,
  makeFakeAgentHome,
  writeClaudeSession,
  writeGeminiSession,
} from './scribe-fixtures.js';

/** Real chokidar integration: watch → append → the slice grows. */
describe('scribe watcher', () => {
  let home: string;
  let roots: ScribeRoots;
  let watcher: ScribeWatcher | null = null;

  afterEach(async () => {
    await watcher?.stop();
    watcher = null;
    cleanupTempHome(home);
  });

  function setup(): ScribeEngine {
    home = useTempHome();
    roots = makeFakeAgentHome(join(home, 'fakehome'));
    const paths = resolvePaths();
    return new ScribeEngine({
      memoryRoot: join(home, 'memory'),
      sessionsDir: paths.scribeSessionsDir,
      cursorStore: new CursorStore(paths.scribeCursorsPath),
      statusPath: paths.scribeStatusPath,
      roots,
      timezone: 'Asia/Shanghai',
    });
  }

  it('watches a root and transcribes appended lines live', async () => {
    const engine = setup();
    const file = writeClaudeSession(roots, 'sess-watch', [
      claudeUserLine('第一条消息', '2026-08-10T14:01:00.000Z', 'sess-watch'),
      claudeAssistantLine([{ kind: 'text', text: '收到。' }], '2026-08-10T14:01:05.000Z', 'sess-watch'),
    ]);
    const core = join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'core.md');

    watcher = new ScribeWatcher(engine, roots);
    await watcher.start();
    await engine.drain();
    await vi.waitFor(() => {
      expect(readFileSync(core, 'utf8')).toContain('第一条消息');
    }, { timeout: 15_000 });

    appendFileSync(
      file,
      claudeUserLine('后来追加的消息', '2026-08-10T14:02:00.000Z', 'sess-watch') + '\n',
      'utf8',
    );
    await vi.waitFor(() => {
      expect(readFileSync(core, 'utf8')).toContain('后来追加的消息');
    }, { timeout: 15_000 });

    // Exactly once: no duplicate transcription of the appended line.
    const md = readFileSync(core, 'utf8');
    expect((md.match(/后来追加的消息/g) ?? []).length).toBe(1);
    expect((md.match(/^## Turn /gm) ?? []).length).toBe(3);

    const status = engine.getStatus();
    expect(status.sources['claude-code'].rootPresent).toBe(true);
    expect(status.sources['claude-code'].lastEventAt).toBe('2026-08-10T14:02:00.000Z');
  }, 30_000);

  it('starts cleanly when every root is missing', async () => {
    const engine = setup();
    watcher = new ScribeWatcher(engine, roots);
    await watcher.start();
    const status = engine.getStatus();
    expect(status.sources['claude-code'].rootPresent).toBe(false);
    expect(status.sources.codex.rootPresent).toBe(false);
    // A root appearing later is picked up by rescan().
    writeClaudeSession(roots, 'sess-late', [
      claudeUserLine('晚到的会话', '2026-08-10T16:00:00.000Z', 'sess-late'),
    ]);
    await watcher.rescan();
    const core = join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1600', 'timeline', 'core.md');
    expect(readFileSync(core, 'utf8')).toContain('晚到的会话');
  }, 30_000);

  it('gemini: whole-file rewrites grow the slice live; a vanished file is graceful', async () => {
    const engine = setup();
    const t1 = '2026-08-10T18:00:00.000Z';
    const file = writeGeminiSession(roots, 'watch', geminiChatDoc('gem-watch', [
      { kind: 'user', text: '第一条 gemini 消息', timestamp: t1 },
    ]));
    const core = join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1800', 'timeline', 'core.md');

    watcher = new ScribeWatcher(engine, roots);
    await watcher.start();
    await engine.drain();
    await vi.waitFor(() => {
      expect(readFileSync(core, 'utf8')).toContain('第一条 gemini 消息');
    }, { timeout: 15_000 });

    // Checkpoint rewrite (same path, whole new document): slice grows in place.
    writeGeminiSession(roots, 'watch', geminiChatDoc('gem-watch', [
      { kind: 'user', text: '第一条 gemini 消息', timestamp: t1 },
      { kind: 'gemini', text: '第二条回复', timestamp: '2026-08-10T18:00:30.000Z' },
    ]));
    await vi.waitFor(() => {
      expect(readFileSync(core, 'utf8')).toContain('第二条回复');
    }, { timeout: 15_000 });
    expect((readFileSync(core, 'utf8').match(/^## Turn /gm) ?? []).length).toBe(2);

    // Retention cleanup deletes the file mid-watch: no crash, no error
    // recorded, slice left intact.
    rmSync(file);
    await watcher.rescan();
    expect(engine.getStatus().errors).toEqual([]);
    expect(readFileSync(core, 'utf8')).toContain('第一条 gemini 消息');
  }, 30_000);

  it('a failing status write inside enqueue does not poison the queue or warn', async () => {
    const engine = setup();
    const rejectionEvents: string[] = [];
    const onUnhandled = (): void => { rejectionEvents.push('unhandledRejection'); };
    const onHandled = (): void => { rejectionEvents.push('rejectionHandled'); };
    process.on('unhandledRejection', onUnhandled);
    process.on('rejectionHandled', onHandled);
    const consoleErrors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => consoleErrors.push(String(msg)));
    try {
      // processFile fails, and the error-recording status write fails too
      // (disk full / antivirus lock) — the secondary failure must be absorbed.
      vi.spyOn(engine, 'processFile').mockRejectedValueOnce(new Error('parse boom'));
      vi.spyOn(engine, 'writeStatus').mockImplementationOnce(() => { throw new Error('disk full'); });

      engine.enqueue(join(roots['claude-code'], 'sess-boom.jsonl'), 'claude-code');
      await engine.drain();

      // The original error was still recorded; the secondary writeStatus
      // failure fell back to stderr instead of rejecting the queued promise.
      expect(engine.getStatus().errors.map((e) => e.message)).toContain('parse boom');
      expect(consoleErrors.join('\n')).toContain('disk full');

      // The queue keeps working after the secondary failure.
      const file = writeClaudeSession(roots, 'sess-after', [
        claudeUserLine('队列仍然可用', '2026-08-10T14:01:00.000Z', 'sess-after'),
      ]);
      engine.enqueue(file, 'claude-code');
      await engine.drain();
      expect(engine.getStatus().sources['claude-code'].events).toBe(1);

      // No unhandled-then-handled rejection (Node's
      // PromiseRejectionHandledWarning) at any point.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejectionEvents).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      process.removeListener('rejectionHandled', onHandled);
    }
  });
});
