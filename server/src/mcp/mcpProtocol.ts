/**
 * The MCP protocol, the small part of it a read-only, stateless server needs:
 * JSON-RPC 2.0 over Streamable HTTP with plain JSON responses (no SSE stream,
 * no session id). `initialize`, `ping`, `tools/list` and `tools/call`; every
 * notification and response a client sends is acknowledged with 202 and
 * otherwise ignored.
 *
 * Pure: a message in, a reply out. The Fastify route (mcpRoute.ts) does the
 * auth and the HTTP, the tools (officeTools.ts) do the reading.
 */

import { MCP_PROTOCOL_VERSIONS } from '../constants.js';

/** One tool: what the client lists, and what a call runs. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** JSON Schema for the arguments (always an object). */
  inputSchema: Record<string, unknown>;
  /** The result, JSON-serialisable. Throw McpToolError for bad arguments. */
  run(args: Record<string, unknown>): unknown;
}

/** A tool call the model can correct (bad arguments, unknown agent): reported
 *  as an `isError` result, not a protocol error, so the model sees why. */
export class McpToolError extends Error {}

export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

/** What to send back: 202 with no body, or 200 with a JSON-RPC response. */
export type McpReply = { status: 202 } | { status: 200; body: JsonRpcResponse };

type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

const PARSE_OR_INVALID = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** True when a client's `MCP-Protocol-Version` header names a revision we speak. */
export function supportsProtocolVersion(version: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export function handleMcpMessage(
  message: unknown,
  tools: readonly McpTool[],
  info: McpServerInfo,
): McpReply {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    // Batches left the protocol in 2025-06-18; anything else isn't JSON-RPC.
    return reply(null, { code: PARSE_OR_INVALID, message: 'Invalid request' });
  }
  const msg = message as Record<string, unknown>;
  const hasId = 'id' in msg && (typeof msg.id === 'string' || typeof msg.id === 'number');
  // A notification (no id) or a response to something we never asked: nothing to say.
  if (!hasId || typeof msg.method !== 'string') {
    return hasId
      ? reply(msg.id as JsonRpcId, { code: PARSE_OR_INVALID, message: 'Invalid request' })
      : { status: 202 };
  }
  const id = msg.id as string | number;
  const params =
    typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, undefined, {
        protocolVersion: supportsProtocolVersion(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }
    case 'ping':
      return reply(id, undefined, {});
    case 'tools/list':
      return reply(id, undefined, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        return reply(id, { code: INVALID_PARAMS, message: `Unknown tool: ${String(params.name)}` });
      }
      const args =
        typeof params.arguments === 'object' &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = tool.run(args);
        return reply(id, undefined, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        if (err instanceof McpToolError) {
          return reply(id, undefined, {
            content: [{ type: 'text', text: err.message }],
            isError: true,
          });
        }
        console.error(`[Pixel Agents] MCP tool ${tool.name} failed:`, err);
        return reply(id, { code: INTERNAL_ERROR, message: 'Internal error' });
      }
    }
    default:
      return reply(id, { code: METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` });
  }
}

function reply(
  id: JsonRpcId,
  error?: { code: number; message: string },
  result?: unknown,
): McpReply {
  return {
    status: 200,
    body: error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result },
  };
}
