import { createInterface } from 'node:readline';
import { PARSE_ERROR, handleMessage, parseMessage, type McpContext, type JsonRpcResponse } from './protocol.js';

/**
 * MCP stdio transport (specification/2025-06-18/basic/transports):
 * newline-delimited JSON-RPC — one message per line, no embedded newlines,
 * nothing but protocol messages on stdout (logging goes to stderr only).
 *
 * Resolving the memory root (client config / PREVIOUSLY_HOME) is the caller's
 * job; this layer just pumps messages.
 */
export function serveStdio(
  ctx: McpContext,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const write = (response: JsonRpcResponse): void => {
    output.write(JSON.stringify(response) + '\n');
  };

  const rl = createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg;
    try {
      msg = parseMessage(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: not valid JSON' } });
      return;
    }
    const response = handleMessage(msg, ctx);
    if (response !== null) write(response);
  });

  return new Promise((resolvePromise) => {
    rl.on('close', () => resolvePromise());
  });
}
