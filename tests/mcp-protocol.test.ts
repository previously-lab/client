import { describe, expect, it } from 'vitest';
import {
  INVALID_PARAMS,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  type McpContext,
} from '../src/mcp/protocol.js';

/**
 * Protocol-shape tests. The framing (newline-delimited JSON-RPC, no embedded
 * newlines, nothing but protocol messages on stdout) and the lifecycle
 * (initialize → echo supported version / else respond with our latest →
 * notifications/initialized) are verified against the published spec; these
 * tests encode those assumptions so spec drift gets caught here.
 */

const ctx: McpContext = {
  memoryRoot: '/nonexistent',
  serverInfo: { name: 'previously', version: '0.0.0-test' },
};

describe('initialize handshake', () => {
  it.each(SUPPORTED_PROTOCOL_VERSIONS)('echoes supported protocol version %s', (version) => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } },
      ctx,
    );
    expect(res).not.toBeNull();
    const result = res!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(version);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual(ctx.serverInfo);
  });

  it('answers an unsupported version with the latest supported one (no error)', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      ctx,
    );
    const result = res!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(res!.error).toBeUndefined();
  });

  it('treats notifications/initialized as a pure notification', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).toBeNull();
  });
});

describe('request dispatch', () => {
  it('answers ping with an empty result', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, ctx);
    expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('rejects unknown methods with -32601', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx);
    expect(res!.error!.code).toBe(METHOD_NOT_FOUND);
    expect(res!.error!.message).toContain('resources/list');
  });

  it('ignores unknown notifications (no id → no response)', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, ctx)).toBeNull();
    expect(handleMessage({ jsonrpc: '2.0', method: 'tools/list' }, ctx)).toBeNull();
  });

  it('ignores stray responses (id but no method)', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 9 }, ctx)).toBeNull();
  });

  it('lists the five read-only tools with input schemas', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'read_timeline',
      'read_slice',
      'list_strands',
      'read_strand',
      'search_memory',
    ]);
    for (const tool of tools) expect(tool.inputSchema).toBeDefined();
  });

  it('rejects unknown tools with -32602', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_slice', arguments: {} } },
      ctx,
    );
    expect(res!.error!.code).toBe(INVALID_PARAMS);
    expect(res!.error!.message).toContain('Unknown tool: write_slice');
  });

  it('rejects tools/call without a tool name', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }, ctx);
    expect(res!.error!.code).toBe(INVALID_PARAMS);
  });

  it('rejects non-object arguments', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_strands', arguments: [] } },
      ctx,
    );
    expect(res!.error!.code).toBe(INVALID_PARAMS);
  });
});

describe('stdio server framing', () => {
  it('newline-delimited JSON-RPC over streams, parse error → -32700', async () => {
    const { PassThrough } = await import('node:stream');
    const { serveStdio } = await import('../src/mcp/server.js');

    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    const done = serveStdio(ctx, input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
    input.write('this is not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await done;

    const lines = chunks.join('').split('\n').filter((l) => l.trim() !== '');
    // Two responses: initialize + parse error + tools/list = 3 lines, and the
    // notification produced none.
    expect(lines).toHaveLength(3);
    const [initRes, parseRes, listRes] = lines.map((l) => JSON.parse(l)) as Array<{
      id: number | null;
      result?: { protocolVersion?: string; tools?: unknown[] };
      error?: { code: number };
    }>;
    expect(initRes!.id).toBe(1);
    expect(initRes!.result!.protocolVersion).toBe('2025-03-26');
    expect(parseRes!.id).toBeNull();
    expect(parseRes!.error!.code).toBe(PARSE_ERROR);
    expect(listRes!.id).toBe(2);
    expect(listRes!.result!.tools).toHaveLength(5);
    // Every line is self-contained JSON (no embedded newlines).
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
