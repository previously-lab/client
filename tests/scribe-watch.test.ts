import { appendFileSync, readFileSync } from 'node:fs';
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
  makeFakeAgentHome,
  writeClaudeSession,
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
});
