import { MemoryError, listStrands, readSlice, readStrand, readTimeline, searchMemory } from '../lib/memory.js';

/**
 * Hand-rolled MCP (Model Context Protocol) server core — JSON-RPC 2.0 message
 * handling, transport-agnostic. The stdio transport (newline-delimited JSON,
 * one message per line, nothing but protocol messages on stdout) lives in
 * ./server.ts. Zero runtime deps: the read-only surface here is small enough
 * that an SDK would buy nothing.
 *
 * Protocol references (verified against modelcontextprotocol.io):
 * - stdio framing: messages delimited by newlines, MUST NOT contain embedded
 *   newlines (specification/2025-06-18/basic/transports)
 * - lifecycle: initialize → respond with same protocolVersion if supported,
 *   else the server's latest; client then sends notifications/initialized
 *   (specification/2025-06-18/basic/lifecycle)
 * - tools: tools/list + tools/call; execution failures are reported in the
 *   result with isError: true, unknown tools/invalid params as JSON-RPC
 *   error -32602 (specification/2025-06-18/server/tools)
 */

/** Protocol versions this server can speak, oldest → newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const;
export const LATEST_PROTOCOL_VERSION: string =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!;

// JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, Json>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

export interface McpContext {
  /** Absolute path of the memory root the read tools operate on. */
  memoryRoot: string;
  /** Server implementation identity reported in initialize. */
  serverInfo: { name: string; version: string };
}

function ok(id: string | number | null, result: Json): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: string | number | null, code: number, message: string, data?: Json): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Parse one input line into a JSON-RPC message. Throws on malformed JSON. */
export function parseMessage(line: string): JsonRpcMessage {
  return JSON.parse(line) as JsonRpcMessage;
}

/**
 * Handle one decoded message. Returns the response to write back, or null for
 * notifications and other messages that must not be answered.
 */
export function handleMessage(msg: JsonRpcMessage, ctx: McpContext): JsonRpcResponse | null {
  if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
    // Not a request — client responses to server-initiated requests (we never
    // send any) and malformed messages without a method are ignored.
    return null;
  }

  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case 'initialize':
      return initialize(msg, ctx);
    case 'notifications/initialized':
      return null; // Handshake complete — nothing to reply.
    case 'ping':
      return isNotification ? null : ok(msg.id ?? null, {});
    case 'tools/list':
      return isNotification ? null : ok(msg.id ?? null, { tools: toolDefinitions() });
    case 'tools/call':
      return isNotification ? null : callTool(msg, ctx);
    default:
      // Notifications (including unknown ones) get no response; unknown
      // requests get a proper JSON-RPC Method-not-found error.
      if (isNotification) return null;
      return err(msg.id ?? null, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

function initialize(msg: JsonRpcMessage, ctx: McpContext): JsonRpcResponse {
  const requested = msg.params?.protocolVersion;
  // Version negotiation: echo the client's version when we support it,
  // otherwise answer with our latest (the client decides whether to stay).
  const protocolVersion =
    typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  return ok(msg.id ?? null, {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: ctx.serverInfo,
    instructions:
      'Read-only access to the local Previously memory (timeline, slices, strands, search).',
  });
}

function toolDefinitions(): Json {
  return [
    {
      name: 'read_timeline',
      description:
        'Read the episodic memory timeline (timeline.md, falling back to timeline/index.json). ' +
        'Optionally filter to one month (YYYY-MM) and/or one day (MM-DD).',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Filter to a month, format YYYY-MM' },
          day: { type: 'string', description: 'Filter to a day within the month, format MM-DD' },
        },
      },
    },
    {
      name: 'read_slice',
      description:
        'Read one time slice\'s conversation record (timeline/core.md) by slice id (YYYY-MM-DD-HHMM). ' +
        'Optionally restrict to a 1-based inclusive line range.',
      inputSchema: {
        type: 'object',
        properties: {
          sliceId: { type: 'string', description: 'Slice id, format YYYY-MM-DD-HHMM' },
          startLine: { type: 'number', description: 'First line to return (1-based, inclusive)' },
          endLine: { type: 'number', description: 'Last line to return (1-based, inclusive)' },
        },
        required: ['sliceId'],
      },
    },
    {
      name: 'list_strands',
      description: 'List all memory strands (thematic threads) with their slice counts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_strand',
      description: 'Read one strand: the list of slice paths (YYYY/MM/DD/HHMM) that belong to it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Strand name (see list_strands)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'search_memory',
      description:
        'Case-insensitive substring search across all slice conversation records and monthly ' +
        'index manifests. Returns matching lines with file paths; capped at 50 matches.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to search for (case-insensitive)' },
        },
        required: ['query'],
      },
    },
  ];
}

function toolErrorResult(message: string): Json {
  // Tool execution errors travel in the result with isError: true, per spec —
  // they are honest data for the model, not protocol failures.
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolTextResult(text: string): Json {
  return { content: [{ type: 'text', text }], isError: false };
}

function callTool(msg: JsonRpcMessage, ctx: McpContext): JsonRpcResponse {
  const id = msg.id ?? null;
  const name = msg.params?.name;
  const args = msg.params?.arguments;
  if (typeof name !== 'string') {
    return err(id, INVALID_PARAMS, 'tools/call requires params.name (string)');
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return err(id, INVALID_PARAMS, 'tools/call params.arguments must be an object');
  }

  try {
    switch (name) {
      case 'read_timeline':
        return ok(
          id,
          toolTextResult(
            readTimeline(ctx.memoryRoot, {
              month: optionalString(args, 'month'),
              day: optionalString(args, 'day'),
            }),
          ),
        );
      case 'read_slice': {
        const sliceId = requiredString(args, 'sliceId');
        return ok(
          id,
          toolTextResult(
            readSlice(ctx.memoryRoot, sliceId, {
              startLine: optionalNumber(args, 'startLine'),
              endLine: optionalNumber(args, 'endLine'),
            }),
          ),
        );
      }
      case 'list_strands': {
        const strands = listStrands(ctx.memoryRoot);
        const text =
          strands.length === 0
            ? 'No strands defined yet (strands.json is empty).'
            : strands.map((s) => `${s.name} (${s.sliceCount} slices)`).join('\n');
        return ok(id, toolTextResult(text));
      }
      case 'read_strand': {
        const strandName = requiredString(args, 'name');
        const strand = readStrand(ctx.memoryRoot, strandName);
        return ok(id, toolTextResult(JSON.stringify(strand, null, 2)));
      }
      case 'search_memory': {
        const query = requiredString(args, 'query');
        return ok(id, toolTextResult(JSON.stringify(searchMemory(ctx.memoryRoot, query), null, 2)));
      }
      default:
        return err(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof MemoryError) {
      return ok(id, toolErrorResult(`${e.code}: ${e.message}`));
    }
    if (e instanceof ArgError) {
      return err(id, INVALID_PARAMS, e.message);
    }
    const message = e instanceof Error ? e.message : String(e);
    return ok(id, toolErrorResult(`internal_error: ${message}`));
  }
}

class ArgError extends Error {}

function optionalString(args: Record<string, Json> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ArgError(`argument ${key} must be a string`);
  return value;
}

function requiredString(args: Record<string, Json> | undefined, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new ArgError(`missing required argument: ${key}`);
  return value;
}

function optionalNumber(args: Record<string, Json> | undefined, key: string): number | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ArgError(`argument ${key} must be an integer`);
  }
  return value;
}
