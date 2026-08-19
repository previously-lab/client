import { describe, expect, it } from 'vitest';
import { parseClaudeCodeLine } from '../src/scribe/parsers/claude-code.js';
import { parseCodexLine } from '../src/scribe/parsers/codex.js';
import {
  claudeAssistantLine,
  claudeMetaLines,
  claudeToolResultLine,
  claudeUserLine,
  codexEnvironmentContextLine,
  codexFunctionCallLine,
  codexFunctionCallOutputLine,
  codexMessageLine,
  codexSessionMetaLine,
} from './scribe-fixtures.js';

describe('claude-code parser', () => {
  const ts = '2026-08-10T14:01:00.000Z';
  const sid = 'sess-claude-1';

  it('parses a user line with string content', () => {
    const out = parseClaudeCodeLine(claudeUserLine('帮我整理项目结构', ts, sid));
    expect(out.appendix).toEqual([]);
    expect(out.sessionId).toBe(sid);
    expect(out.events).toEqual([{ timestamp: ts, role: 'user', text: '帮我整理项目结构' }]);
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
    expect(out.events[0]).toEqual({ timestamp: ts, role: 'agent', text: '好的，我先看一下。' });
    expect(out.events[1]).toMatchObject({ timestamp: ts, role: 'agent', toolName: 'Bash' });
    expect(out.events[1]!.text).toBe('ls -la');
  });

  it('skips tool-result user lines (not human speech)', () => {
    const out = parseClaudeCodeLine(claudeToolResultLine('file1\nfile2', ts, sid));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('skips meta lines quietly (mode, permission-mode, snapshot, system)', () => {
    for (const line of claudeMetaLines(sid)) {
      const out = parseClaudeCodeLine(line);
      expect(out.events).toEqual([]);
      expect(out.appendix).toEqual([]);
    }
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
    expect(out.events).toEqual([{ timestamp: ts, role: 'user', text: '第一段\n\n第二段' }]);
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
    expect(user.events).toEqual([{ timestamp: ts, role: 'user', text: '写一个 hello world' }]);
    const agent = parseCodexLine(codexMessageLine('assistant', '写好了。', ts));
    expect(agent.events).toEqual([{ timestamp: ts, role: 'agent', text: '写好了。' }]);
  });

  it('skips injected environment_context messages', () => {
    const out = parseCodexLine(codexEnvironmentContextLine(ts));
    expect(out.events).toEqual([]);
    expect(out.appendix).toEqual([]);
  });

  it('parses function_call into a tool event with truncated arguments', () => {
    const out = parseCodexLine(codexFunctionCallLine('shell', '{"command":["bash","-lc","ls"]}', ts));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ timestamp: ts, role: 'agent', toolName: 'shell' });
    expect(out.events[0]!.text).toContain('bash');
  });

  it('skips function_call_output and other non-conversational payloads', () => {
    expect(parseCodexLine(codexFunctionCallOutputLine('done', ts)).events).toEqual([]);
    const reasoning = JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'reasoning', summary: [] } });
    expect(parseCodexLine(reasoning).events).toEqual([]);
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
