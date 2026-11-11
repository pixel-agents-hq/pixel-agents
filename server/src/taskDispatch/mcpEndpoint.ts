/**
 * The JSON-RPC side of `POST /mcp` (task dispatch, standalone only): the MCP
 * subset the stdio shim forwards -- initialize, notifications, ping,
 * tools/list and tools/call for the single `dispatch_task` tool.
 *
 * Authentication and the network-level filter happen before this (httpServer
 * registerTaskDispatchRoute): by the time a body reaches here the request had
 * exactly one Authorization header carrying a currently valid capability. That
 * header value is passed through to the dispatcher, which verifies it again
 * inside its synchronous block.
 *
 * Batches (array bodies) are refused: one request, one answer, one dispatch.
 */

import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  TASK_DISPATCH_DENIED_MESSAGE,
  TASK_DISPATCH_MAX_TASK_CHARS,
  TASK_DISPATCH_MCP_PROTOCOL_VERSIONS,
  TASK_DISPATCH_MCP_SERVER_NAME,
  TASK_DISPATCH_TOOL_NAME,
} from '../constants.js';
import type { DispatchResult } from './taskDispatcher.js';

export interface McpReply {
  status: number;
  /** JSON body; absent for a 202 (notification). */
  body?: Record<string, unknown>;
}

export interface McpEndpointDeps {
  dispatch(authorization: string, args: unknown): Promise<DispatchResult>;
  version: string;
}

const TOOL_DEFINITION = {
  name: TASK_DISPATCH_TOOL_NAME,
  description:
    "Write a task into the terminal of another running agent in this Workspace. Only this Workspace's curator may use it, and only while the target agent is idle. The server answers only whether the task was written to the target's terminal; it does not report whether the agent accepted or completed it.",
  inputSchema: {
    type: 'object',
    properties: {
      targetAgentId: {
        type: 'integer',
        minimum: 1,
        description: 'Id of the target agent (shown on its card as "Agent N").',
      },
      task: {
        type: 'string',
        minLength: 1,
        maxLength: TASK_DISPATCH_MAX_TASK_CHARS,
        description:
          'The task text. Plain text only: no control characters, and no @file mentions.',
      },
    },
    required: ['targetAgentId', 'task'],
    additionalProperties: false,
  },
} as const;

function errorReply(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function resultReply(id: unknown, result: Record<string, unknown>): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function isValidId(id: unknown): boolean {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function toolText(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** The success text: says only that the task was written, never "accepted". */
function dispatchSuccessText(result: Extract<DispatchResult, { ok: true }>): string {
  const name = result.displayName ?? `Agent ${result.targetAgentId}`;
  const directory = result.directoryName ?? '';
  return `Task written to terminal of ${JSON.stringify(name)} (agent ${result.targetAgentId}, directory ${JSON.stringify(directory)}).`;
}

/** Answer one parsed /mcp body. `authorization` is the request's single header value. */
export async function handleMcpBody(
  body: unknown,
  authorization: string,
  deps: McpEndpointDeps,
): Promise<McpReply> {
  if (Array.isArray(body)) {
    return errorReply(null, JSON_RPC_INVALID_REQUEST, 'Batch requests are not supported', 400);
  }
  if (typeof body !== 'object' || body === null) {
    return errorReply(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request', 400);
  }
  const message = body as Record<string, unknown>;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A response object or malformed request: nothing to answer with an id.
    if (!('id' in message)) return { status: 202 };
    return errorReply(message.id, JSON_RPC_INVALID_REQUEST, 'Invalid Request', 400);
  }

  // A notification (no id): accepted, never answered.
  if (!('id' in message)) return { status: 202 };
  const { id } = message;
  if (!isValidId(id)) return errorReply(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request', 400);

  switch (message.method) {
    case 'initialize': {
      const params = message.params as Record<string, unknown> | undefined;
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && TASK_DISPATCH_MCP_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : TASK_DISPATCH_MCP_PROTOCOL_VERSIONS[0];
      return resultReply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: TASK_DISPATCH_MCP_SERVER_NAME, version: deps.version },
      });
    }
    case 'ping':
      return resultReply(id, {});
    case 'tools/list':
      return resultReply(id, { tools: [TOOL_DEFINITION] });
    case 'tools/call': {
      const params = message.params as Record<string, unknown> | undefined;
      if (
        typeof params !== 'object' ||
        params === null ||
        params.name !== TASK_DISPATCH_TOOL_NAME
      ) {
        return errorReply(id, JSON_RPC_INVALID_PARAMS, 'Unknown tool');
      }
      const result = await deps.dispatch(authorization, params.arguments);
      return resultReply(
        id,
        result.ok
          ? toolText(dispatchSuccessText(result), false)
          : toolText(TASK_DISPATCH_DENIED_MESSAGE, true),
      );
    }
    default:
      return errorReply(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found');
  }
}
