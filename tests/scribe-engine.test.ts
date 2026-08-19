import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/lib/paths.js';
import { CursorStore } from '../src/scribe/cursor.js';
import { readScribeStatus } from '../src/scribe/status.js';
import { ScribeEngine } from '../src/scribe/watcher.js';
import type { ScribeRoots } from '../src/scribe/types.js';
import { cleanupTempHome, useTempHome } from './helpers.js';
import {
  claudeAssistantLine,
  claudeMetaLines,
  claudeToolResultLine,
  claudeUserLine,
  codexFunctionCallLine,
  codexFunctionCallOutputLine,
  codexMessageLine,
  codexSessionMetaLine,
  makeFakeAgentHome,
  writeClaudeSession,
  writeCodexSession,
} from './scribe-fixtures.js';

/**
 * Engine tests run fully sandboxed: PREVIOUSLY_HOME points at a temp dir and
 * the agent session-log roots are fake HOME trees inside it.
 */
describe('scribe engine', () => {
  let home: string;
  let roots: ScribeRoots;
  afterEach(() => cleanupTempHome(home));

  function setup(): ScribeEngine {
    home = useTempHome();
    roots = makeFakeAgentHome(join(home, 'fakehome'));
    return makeEngine();
  }

  function makeEngine(): ScribeEngine {
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

  function claudeSessionLines(sessionId: string, baseMinute: string): string[] {
    return [
      ...claudeMetaLines(sessionId),
      claudeUserLine('帮我整理项目结构', `${baseMinute}:00.000Z`, sessionId),
      claudeAssistantLine(
        [
          { kind: 'text', text: '好的，我先看一下。' },
          { kind: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
        `${baseMinute}:05.000Z`,
        sessionId,
      ),
      claudeToolResultLine('src\ntests', `${baseMinute}:06.000Z`, sessionId),
      claudeAssistantLine([{ kind: 'text', text: '项目有 src 和 tests。' }], `${baseMinute}:08.000Z`, sessionId),
    ];
  }

  function coreMd(sliceId: string): string {
    const [y, m, d, hm] = sliceId.split('-');
    return join(home, 'memory', 'episodic', 'slices', y!, m!, d!, hm!, 'timeline', 'core.md');
  }

  function countTurns(sliceId: string): number {
    return (readFileSync(coreMd(sliceId), 'utf8').match(/^## Turn /gm) ?? []).length;
  }

  it('scribe once backfills both sources into slices', async () => {
    const engine = setup();
    writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    writeCodexSession(roots, '2026-08-10T15-30-00-rollout1', [
      codexSessionMetaLine('rollout-1', '2026-08-10T15:30:00.000Z'),
      codexMessageLine('user', '写一个 hello world', '2026-08-10T15:30:02.000Z'),
      codexFunctionCallLine('shell', '{"command":["bash","-lc","cat > hello.py"]}', '2026-08-10T15:30:06.000Z'),
      codexFunctionCallOutputLine('done', '2026-08-10T15:30:07.000Z'),
      codexMessageLine('assistant', '写好了。', '2026-08-10T15:30:09.000Z'),
    ]);

    const summary = await engine.scanOnce();
    expect(summary.errors).toEqual([]);
    expect(summary.sources['claude-code'].filesProcessed).toBe(1);
    expect(summary.sources.codex.filesProcessed).toBe(1);
    // Claude: meta/tool_result skipped → user + agent text + tool + agent text = 4.
    expect(summary.sources['claude-code'].events).toBe(4);
    // Codex: session_meta/output skipped → user + tool + agent = 3.
    expect(summary.sources.codex.events).toBe(3);

    const claudeMd = readFileSync(coreMd('2026-08-10-1401'), 'utf8');
    expect(claudeMd).toContain('source: claude-code');
    expect(claudeMd).toContain('session_id: sess-a');
    expect(claudeMd).toContain('帮我整理项目结构');
    expect(claudeMd).toContain('**Tool: Bash**');

    const codexMd = readFileSync(coreMd('2026-08-10-1530'), 'utf8');
    expect(codexMd).toContain('source: codex');
    expect(codexMd).toContain('session_id: rollout-1');
    expect(codexMd).toContain('写一个 hello world');

    const index = JSON.parse(
      readFileSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '_index.json'), 'utf8'),
    ) as { slices: { id: string; source: string; sessionId: string }[] };
    expect(index.slices.map((s) => [s.id, s.source, s.sessionId])).toEqual([
      ['2026-08-10-1401', 'claude-code', 'sess-a'],
      ['2026-08-10-1530', 'codex', 'rollout-1'],
    ]);
  });

  it('incremental tail: appended lines grow the slice', async () => {
    const engine = setup();
    const file = writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    await engine.scanOnce();
    expect(countTurns('2026-08-10-1401')).toBe(4);

    appendFileSync(
      file,
      claudeUserLine('再帮我看看测试', '2026-08-10T14:05:00.000Z', 'sess-a') + '\n' +
        claudeAssistantLine([{ kind: 'text', text: '测试都在 tests/ 下。' }], '2026-08-10T14:05:10.000Z', 'sess-a') + '\n',
      'utf8',
    );
    const result = await engine.processFile(file, 'claude-code');
    expect(result!.newEvents).toBe(2);
    expect(countTurns('2026-08-10-1401')).toBe(6);
    expect(readFileSync(coreMd('2026-08-10-1401'), 'utf8')).toContain('再帮我看看测试');
  });

  it('restart resumes from the cursor: no duplicate turns, byte-identical until new input', async () => {
    const engine1 = setup();
    const file = writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    await engine1.scanOnce();
    const before = readFileSync(coreMd('2026-08-10-1401'), 'utf8');

    // Fresh engine (process restart): a no-change rescan must not rewrite bytes.
    const engine2 = makeEngine();
    const summary = await engine2.scanOnce();
    expect(summary.sources['claude-code'].events).toBe(0);
    expect(readFileSync(coreMd('2026-08-10-1401'), 'utf8')).toBe(before);

    // New input after the restart is picked up exactly once.
    appendFileSync(file, claudeUserLine('重启后还在吗', '2026-08-10T14:09:00.000Z', 'sess-a') + '\n', 'utf8');
    await engine2.scanOnce();
    expect(countTurns('2026-08-10-1401')).toBe(5);
  });

  it('detects truncation: a shrunken file is re-read from byte 0', async () => {
    const engine = setup();
    const file = writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    await engine.scanOnce();
    expect(countTurns('2026-08-10-1401')).toBe(4);

    // Simulate log rotation: same path, brand-new shorter content.
    writeFileSync(
      file,
      claudeUserLine('新的会话开始了', '2026-08-10T14:01:30.000Z', 'sess-a') + '\n',
      'utf8',
    );
    const result = await engine.processFile(file, 'claude-code');
    expect(result!.truncated).toBe(true);
    const md = readFileSync(coreMd('2026-08-10-1401'), 'utf8');
    expect(md).toContain('新的会话开始了');
    expect(md).not.toContain('帮我整理项目结构');
    expect(countTurns('2026-08-10-1401')).toBe(1);
  });

  it('malformed lines land in the appendix and are counted, without killing the slice', async () => {
    const engine = setup();
    const file = writeClaudeSession(roots, 'sess-a', [
      claudeUserLine('第一条', '2026-08-10T14:01:00.000Z', 'sess-a'),
      '{"type":"user",oops-not-json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: '没有时间戳' }, sessionId: 'sess-a' }),
      claudeAssistantLine([{ kind: 'text', text: '第二条回复' }], '2026-08-10T14:01:10.000Z', 'sess-a'),
    ]);
    const result = await engine.processFile(file, 'claude-code');
    expect(result!.newEvents).toBe(2);
    expect(result!.newParseErrors).toBe(2);

    const appendixPath = join(home, 'memory', 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline', 'appendix.md');
    const appendix = readFileSync(appendixPath, 'utf8');
    expect(appendix).toContain('{"type":"user",oops-not-json');
    expect(appendix).toContain('没有时间戳');

    const status = readScribeStatus(resolvePaths().scribeStatusPath);
    expect(status).not.toBeNull();
    expect(status!.sources['claude-code'].parseErrors).toBe(2);
    expect(countTurns('2026-08-10-1401')).toBe(2);
  });

  it('holds a trailing partial line until it is completed', async () => {
    const engine = setup();
    const file = writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    await engine.scanOnce();

    // A line still being written: no trailing newline yet.
    appendFileSync(file, '{"type":"user","message":{"role":"user","content":"半行"', 'utf8');
    const partial = await engine.processFile(file, 'claude-code');
    expect(partial!.newEvents).toBe(0);
    expect(countTurns('2026-08-10-1401')).toBe(4);

    // Complete it; the merged line parses and lands.
    appendFileSync(file, '},"timestamp":"2026-08-10T14:07:00.000Z","sessionId":"sess-a"}\n', 'utf8');
    const completed = await engine.processFile(file, 'claude-code');
    expect(completed!.newEvents).toBe(1);
    expect(readFileSync(coreMd('2026-08-10-1401'), 'utf8')).toContain('半行');
  });

  it('multi-session: concurrent files produce independent slices', async () => {
    const engine = setup();
    writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    writeClaudeSession(roots, 'sess-b', claudeSessionLines('sess-b', '2026-08-10T14:20'));
    const summary = await engine.scanOnce();
    expect(summary.sources['claude-code'].filesProcessed).toBe(2);
    expect(existsSync(coreMd('2026-08-10-1401'))).toBe(true);
    expect(existsSync(coreMd('2026-08-10-1420'))).toBe(true);
    expect(readFileSync(coreMd('2026-08-10-1401'), 'utf8')).toContain('session_id: sess-a');
    expect(readFileSync(coreMd('2026-08-10-1420'), 'utf8')).toContain('session_id: sess-b');
  });

  it('same-minute sessions get distinct slice ids', async () => {
    const engine = setup();
    writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    writeClaudeSession(roots, 'sess-b', claudeSessionLines('sess-b', '2026-08-10T14:01'));
    await engine.scanOnce();
    expect(existsSync(coreMd('2026-08-10-1401'))).toBe(true);
    expect(existsSync(coreMd('2026-08-10-1402'))).toBe(true);
  });

  it('dedup: re-processing the same logs yields byte-identical files', async () => {
    const engine = setup();
    writeClaudeSession(roots, 'sess-a', claudeSessionLines('sess-a', '2026-08-10T14:01'));
    writeCodexSession(roots, 'r1', [
      codexSessionMetaLine('rollout-1', '2026-08-10T15:30:00.000Z'),
      codexMessageLine('user', '你好', '2026-08-10T15:30:02.000Z'),
      codexMessageLine('assistant', '你好！', '2026-08-10T15:30:05.000Z'),
    ]);
    await engine.scanOnce();
    const claudeBefore = readFileSync(coreMd('2026-08-10-1401'), 'utf8');
    const codexBefore = readFileSync(coreMd('2026-08-10-1530'), 'utf8');
    const indexBefore = readFileSync(
      join(home, 'memory', 'episodic', 'slices', '2026', '08', '_index.json'),
      'utf8',
    );

    // Fresh engine, forced full re-read (parser version bump is simulated by
    // deleting cursors): bytes must come out identical.
    writeFileSync(resolvePaths().scribeCursorsPath, '{"_schema":1,"files":{}}', 'utf8');
    const engine2 = makeEngine();
    await engine2.scanOnce();
    expect(readFileSync(coreMd('2026-08-10-1401'), 'utf8')).toBe(claudeBefore);
    expect(readFileSync(coreMd('2026-08-10-1530'), 'utf8')).toBe(codexBefore);
    expect(
      readFileSync(join(home, 'memory', 'episodic', 'slices', '2026', '08', '_index.json'), 'utf8'),
    ).toBe(indexBefore);
  });

  it('missing roots are reported absent, never a crash', async () => {
    const engine = setup();
    const summary = await engine.scanOnce();
    expect(summary.errors).toEqual([]);
    expect(summary.sources['claude-code'].rootPresent).toBe(false);
    expect(summary.sources.codex.rootPresent).toBe(false);
    const status = readScribeStatus(resolvePaths().scribeStatusPath);
    expect(status!.sources['claude-code'].rootPresent).toBe(false);
  });
});
