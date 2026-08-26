import { describe, expect, it } from 'vitest';
import { parseClaudeCodeLine } from '../src/scribe/parsers/claude-code.js';
import { parseCodexLine } from '../src/scribe/parsers/codex.js';
import { parseGeminiDoc } from '../src/scribe/parsers/gemini.js';
import { kimiSessionIdFromPath, parseKimiCodeLine } from '../src/scribe/parsers/kimi-code.js';
import {
  claudeAssistantLine,
  claudeMetaLines,
  claudeSidechainLine,
  claudeToolResultLine,
  claudeUserLine,
  codexEnvironmentContextLine,
  codexFunctionCallLine,
  codexFunctionCallOutputLine,
  codexMessageLine,
  codexReasoningLine,
  codexSessionMetaLine,
  geminiChatDoc,
  kimiWireAgentTextLine,
  kimiWireMetaLines,
  kimiWireThinkLine,
  kimiWireToolCallLine,
  kimiWireToolResultLine,
  kimiWireUserLine,
} from './scribe-fixtures.js';

describe('claude-code parser', () => {
  const ts = '2026-08-10T14:01:00.000Z';
  const sid = 'sess-claude-1';

  it('parses a user line with string content', () => {
    const out = parseClaudeCodeLine(claudeUserLine('帮我整理项目结构', ts, sid));
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe(sid);
    expect(out.events).toEqual([{ timestamp: ts, kind: 'user', text: '帮我整理项目结构' }]);
  });

  it('parses an assistant line into text + tool_use events in order', () => {
    const out = parseClaudeCodeLine(
      claudeAssistantLine(
        [
          { kind: 'text', text: '好的，我先看一下。' },
          { kind: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
        ts,
        sid,
      ),
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toEqual({ timestamp: ts, kind: 'agent-text', text: '好的，我先看一下。' });
    expect(out.events[1]).toEqual({
      timestamp: ts,
      kind: 'tool-call',
      toolName: 'Bash',
      text: 'ls -la',
      toolCallId: 'toolu_1',
    });
  });

  it('parses a thinking block into a thinking event', () => {
    const out = parseClaudeCodeLine(
      claudeAssistantLine(
        [
          { kind: 'thinking', text: '用户想要项目结构，先列目录。' },
          { kind: 'text', text: '好的。' },
        ],
        ts,
        sid,
      ),
    );
    expect(out.events).toEqual([
      { timestamp: ts, kind: 'thinking', text: '用户想要项目结构，先列目录。' },
      { timestamp: ts, kind: 'agent-text', text: '好的。' },
    ]);
  });

  it('parses tool_result blocks into tool-result events paired by tool_use_id', () => {
    const ok = parseClaudeCodeLine(claudeToolResultLine('src\ntests', ts, sid));
    expect(ok.events).toEqual([
      { timestamp: ts, kind: 'tool-result', toolCallId: 'toolu_0', text: 'src tests', isError: false },
    ]);
    expect(ok.appendix).toEqual([]);

    const failed = parseClaudeCodeLine(
      claudeToolResultLine('command failed: exit 1', ts, sid, { toolUseId: 'toolu_9', isError: true }),
    );
    expect(failed.events).toEqual([
      { timestamp: ts, kind: 'tool-result', toolCallId: 'toolu_9', text: 'command failed: exit 1', isError: true },
    ]);
  });

  it('skips meta lines quietly (mode, permission-mode, snapshot, system)', () => {
    for (const line of claudeMetaLines(sid)) {
      const out = parseClaudeCodeLine(line);
      expect(out.events).toEqual([]);
      expect(out.appendix).toEqual([]);
    }
  });

  it('skips sidechain (subagent) lines quietly', () => {
    const out = parseClaudeCodeLine(claudeSidechainLine('子代理的内部对话', ts, sid));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe(sid);
  });

  it('skips unknown future line types quietly but keeps the sessionId', () => {
    const out = parseClaudeCodeLine(JSON.stringify({ type: 'future-thing', sessionId: sid, x: 1 }));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe(sid);
  });

  it('sends invalid JSON to the appendix', () => {
    const out = parseClaudeCodeLine('{"type":"user",oops');
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual(['{"type":"user",oops']);
  });

  it('sends a conversational line without a timestamp to the appendix', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      sessionId: sid,
    });
    const out = parseClaudeCodeLine(line);
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([line]);
  });

  it('parses user lines whose content is an array of text blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
      timestamp: ts,
      sessionId: sid,
    });
    const out = parseClaudeCodeLine(line);
    expect(out.events).toEqual([{ timestamp: ts, kind: 'user', text: '第一段\n\n第二段' }]);
  });

  describe('harness envelope unwrapping', () => {
    it('unwraps <command-name>/<command-args> into a /command user event', () => {
      const text =
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>fast mode</command-args>';
      const out = parseClaudeCodeLine(claudeUserLine(text, ts, sid));
      expect(out.events).toEqual([{ timestamp: ts, kind: 'user', text: '/compact fast mode' }]);
    });

    it('strips a leading <local-command-caveat> and keeps the real text', () => {
      const text = '<local-command-caveat>Caveat: the messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>\n实际想问的问题';
      const out = parseClaudeCodeLine(claudeUserLine(text, ts, sid));
      expect(out.events).toEqual([{ timestamp: ts, kind: 'user', text: '实际想问的问题' }]);
    });

    it('strips <system-reminder> blocks once the message is being unwrapped; a pure-reminder message emits nothing', () => {
      // Reminders are stripped globally while unwrapping a recognized envelope.
      const mixed = parseClaudeCodeLine(
        claudeUserLine('<command-name>/review</command-name>\n<system-reminder>别忘了格式化</system-reminder>正文内容', ts, sid),
      );
      expect(mixed.events).toEqual([{ timestamp: ts, kind: 'user', text: '/review\n\n正文内容' }]);

      const pure = parseClaudeCodeLine(
        claudeUserLine('<system-reminder>纯属注入</system-reminder>', ts, sid),
      );
      expect(pure.events).toEqual([]);
      expect(pure.appendix).toEqual([]);
    });

    it('turns <task-notification> into a cognition-side tool-result, keeping trailing speech', () => {
      const text =
        '<task-notification><task-id>task-1</task-id><summary>子代理完成了代码搜索</summary></task-notification>\n继续下一步';
      const out = parseClaudeCodeLine(claudeUserLine(text, ts, sid));
      expect(out.events).toEqual([
        { timestamp: ts, kind: 'tool-result', toolName: 'task', text: '子代理完成了代码搜索', isError: false },
        { timestamp: ts, kind: 'user', text: '继续下一步' },
      ]);
    });

    it('unwraps <local-command-stdout> to its content', () => {
      const out = parseClaudeCodeLine(
        claudeUserLine('<local-command-stdout>total 42\n-rw-r--r-- 1 dream staff a.ts</local-command-stdout>', ts, sid),
      );
      expect(out.events).toEqual([
        { timestamp: ts, kind: 'user', text: 'total 42\n-rw-r--r-- 1 dream staff a.ts' },
      ]);
    });

    it('leaves ordinary prose with html-ish tags untouched', () => {
      const mid = parseClaudeCodeLine(claudeUserLine('帮我解释 <script>alert(1)</script> 是干什么的', ts, sid));
      expect(mid.events).toEqual([
        { timestamp: ts, kind: 'user', text: '帮我解释 <script>alert(1)</script> 是干什么的' },
      ]);
      // Even a message STARTING with an unknown tag is returned verbatim.
      const leading = parseClaudeCodeLine(claudeUserLine('<b>加粗</b> 这段文字', ts, sid));
      expect(leading.events).toEqual([{ timestamp: ts, kind: 'user', text: '<b>加粗</b> 这段文字' }]);
    });
  });
});

describe('codex parser', () => {
  const ts = '2026-08-10T15:30:02.000Z';

  it('extracts the session id from session_meta without emitting events', () => {
    const out = parseCodexLine(codexSessionMetaLine('rollout-1', ts));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe('rollout-1');
  });

  it('parses user and assistant messages', () => {
    const user = parseCodexLine(codexMessageLine('user', '写一个 hello world', ts));
    expect(user.events).toEqual([{ timestamp: ts, kind: 'user', text: '写一个 hello world' }]);
    const agent = parseCodexLine(codexMessageLine('assistant', '写好了。', ts));
    expect(agent.events).toEqual([{ timestamp: ts, kind: 'agent-text', text: '写好了。' }]);
  });

  it('skips injected environment_context messages', () => {
    const out = parseCodexLine(codexEnvironmentContextLine(ts));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('parses function_call into a tool-call event with truncated arguments', () => {
    const out = parseCodexLine(codexFunctionCallLine('shell', '{"command":["bash","-lc","ls"]}', ts, 'call_1'));
    expect(out.events).toEqual([
      {
        timestamp: ts,
        kind: 'tool-call',
        toolName: 'shell',
        text: '{"command":["bash","-lc","ls"]}',
        toolCallId: 'call_1',
      },
    ]);
  });

  it('parses function_call_output into a tool-result event paired by call_id', () => {
    const out = parseCodexLine(codexFunctionCallOutputLine('hello.py written', ts, 'call_1'));
    expect(out.events).toEqual([
      { timestamp: ts, kind: 'tool-result', toolCallId: 'call_1', text: 'hello.py written', isError: false },
    ]);
  });

  it('parses reasoning summaries into thinking events; empty ones are skipped', () => {
    const out = parseCodexLine(codexReasoningLine('先写文件再验证', ts));
    expect(out.events).toEqual([{ timestamp: ts, kind: 'thinking', text: '先写文件再验证' }]);

    const empty = JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'reasoning', summary: [] } });
    expect(parseCodexLine(empty).events).toEqual([]);
    const turnContext = JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { cwd: '/' } });
    expect(parseCodexLine(turnContext).events).toEqual([]);
  });

  it('sends invalid JSON to the appendix', () => {
    const out = parseCodexLine('not json at all');
    expect(out.appendix).toEqual(['not json at all']);
  });

  it('sends a conversational item without a timestamp to the appendix', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    });
    const out = parseCodexLine(line);
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([line]);
  });
});

/* ---- Kimi Code wire parser (shape VERIFIED against real wire.jsonl files) ---- */

describe('kimi-code parser', () => {
  // 2026-08-10T17:00:00.000Z
  const t0 = Date.parse('2026-08-10T17:00:00.000Z');
  const iso = '2026-08-10T17:00:00.000Z';

  it('parses a user append_message into a user event (epoch-ms → ISO)', () => {
    const out = parseKimiCodeLine(kimiWireUserLine('帮我看看这个仓库', t0));
    expect(out.appendix).toEqual([]);
    expect(out.events).toEqual([{ timestamp: iso, kind: 'user', text: '帮我看看这个仓库' }]);
  });

  it('parses content.part text parts into agent-text events', () => {
    const out = parseKimiCodeLine(kimiWireAgentTextLine('好的，我先看一下。', t0));
    expect(out.events).toEqual([{ timestamp: iso, kind: 'agent-text', text: '好的，我先看一下。' }]);
  });

  it('parses think parts into thinking events (text lives in the think field)', () => {
    const out = parseKimiCodeLine(kimiWireThinkLine('用户想让我看仓库…', t0));
    expect(out.events).toEqual([{ timestamp: iso, kind: 'thinking', text: '用户想让我看仓库…' }]);
    expect(out.appendix).toEqual([]);
  });

  it('parses tool.call into a tool-call event with truncated args', () => {
    const out = parseKimiCodeLine(kimiWireToolCallLine('Bash', { command: 'ls -la' }, t0, 'tool_abc'));
    expect(out.events).toEqual([
      { timestamp: iso, kind: 'tool-call', toolName: 'Bash', text: 'ls -la', toolCallId: 'tool_abc' },
    ]);
  });

  it('parses tool.result into a tool-result event paired by toolCallId', () => {
    const out = parseKimiCodeLine(kimiWireToolResultLine('src tests', false, t0, 'tool_abc'));
    expect(out.events).toEqual([
      { timestamp: iso, kind: 'tool-result', toolCallId: 'tool_abc', text: 'src tests', isError: false },
    ]);
    const failed = parseKimiCodeLine(kimiWireToolResultLine('boom', true, t0, 'tool_def'));
    expect(failed.events).toEqual([
      { timestamp: iso, kind: 'tool-result', toolCallId: 'tool_def', text: 'boom', isError: true },
    ]);
  });

  it('skips harness bookkeeping quietly (metadata, profile.bind, turn.prompt, …)', () => {
    for (const line of kimiWireMetaLines('重复的用户输入', t0)) {
      const out = parseKimiCodeLine(line);
      expect(out.events).toEqual([]);
      expect(out.appendix).toEqual([]);
    }
  });

  it('skips unknown future line types quietly', () => {
    const out = parseKimiCodeLine(JSON.stringify({ type: 'future.thing', time: t0, x: 1 }));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('sends invalid JSON to the appendix', () => {
    const out = parseKimiCodeLine('{"type":"context.append_message",oops');
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual(['{"type":"context.append_message",oops']);
  });

  it('sends a conversational line without a time to the appendix', () => {
    const line = JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: '没有时间' }] },
    });
    const out = parseKimiCodeLine(line);
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([line]);
  });

  it('skips image-only user messages (no text blocks)', () => {
    const line = JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///x.png' } }] },
      time: t0,
    });
    const out = parseKimiCodeLine(line);
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('derives the session id from the wire path', () => {
    expect(
      kimiSessionIdFromPath(
        'C:\\Users\\Dream\\.kimi-code\\sessions\\wd_proj_ab12\\session_159b57a1-39d3-4738-a8ba-fcc1b3150388\\agents\\main\\wire.jsonl',
      ),
    ).toBe('session_159b57a1-39d3-4738-a8ba-fcc1b3150388/main');
    expect(
      kimiSessionIdFromPath(
        '/home/u/.kimi-code/sessions/wd_proj_ab12/session_aaaa/agents/agent-3/wire.jsonl',
      ),
    ).toBe('session_aaaa/agent-3');
    expect(kimiSessionIdFromPath('/tmp/other/wire.jsonl')).toBeUndefined();
  });
});

/* ---- Gemini CLI checkpoint parser (ASSUMED shape — no real install) ---- */

describe('gemini parser (ASSUMED format)', () => {
  const t1 = '2026-08-10T17:00:00.000Z';
  const t2 = '2026-08-10T17:00:30.000Z';

  it('parses user and gemini messages with toolCalls', () => {
    const doc = geminiChatDoc('gem-sess-1', [
      { kind: 'user', text: '列出目录', timestamp: t1 },
      {
        kind: 'gemini',
        text: '好的。',
        timestamp: t2,
        toolCalls: [{ name: 'run_shell_command', args: { command: 'ls' } }],
      },
      { kind: 'info', text: 'checkpoint saved', timestamp: t2 },
    ]);
    const out = parseGeminiDoc(doc);
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe('gem-sess-1');
    // info message skipped; user + agent text + tool call remain.
    expect(out.events).toEqual([
      { timestamp: t1, kind: 'user', text: '列出目录' },
      { timestamp: t2, kind: 'agent-text', text: '好的。' },
      { timestamp: t2, kind: 'tool-call', toolName: 'run_shell_command', text: '{"command":"ls"}' },
    ]);
  });

  it('skips messages with no conversational content', () => {
    const doc = JSON.stringify({
      sessionId: 's',
      messages: [
        { id: 'm1', timestamp: t1, type: 'warning', content: 'quota low' },
        { id: 'm2', timestamp: t1, type: 'tool_group', toolCalls: [] },
        { id: 'm3', timestamp: t1, type: 'gemini', content: '' },
      ],
    });
    const out = parseGeminiDoc(doc);
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('sends a conversational message without a timestamp to the appendix', () => {
    const doc = JSON.stringify({
      sessionId: 's',
      messages: [{ id: 'm1', type: 'user', content: [{ text: '没有时间戳' }] }],
    });
    const out = parseGeminiDoc(doc);
    expect(out.events).toEqual([]);
    expect(out.appendix).toHaveLength(1);
    expect(out.appendix[0]).toContain('没有时间戳');
  });

  it('sends an unparseable document to the appendix as a capped preview', () => {
    const garbage = 'x'.repeat(10_000);
    const out = parseGeminiDoc(garbage);
    expect(out.events).toEqual([]);
    expect(out.appendix).toHaveLength(1);
    expect(out.appendix[0]!.length).toBeLessThan(5000);
    expect(out.appendix[0]).toContain('truncated');
  });

  it('sends a doc without a messages array to the appendix', () => {
    const out = parseGeminiDoc(JSON.stringify({ sessionId: 's', notMessages: [] }));
    expect(out.events).toEqual([]);
    expect(out.appendix).toHaveLength(1);
  });
});
