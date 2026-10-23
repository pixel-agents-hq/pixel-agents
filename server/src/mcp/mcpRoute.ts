/**
 * `POST /mcp`: the office as an MCP server (Streamable HTTP, stateless, JSON
 * responses). Standalone only. Connect Claude Code with
 *
 *   claude mcp add --transport http pixel-agents http://127.0.0.1:3100/mcp \
 *     --header "Authorization: Bearer <~/.pixel-agents/standalone-token>"
 *
 * Gates, in order -- the same ones a privileged `/ws` handshake passes:
 * 1. The server token as a Bearer header. First, so a probe without it learns
 *    nothing else about the server.
 * 2. An allowed Host (loopback, a specific --host, an --allowed-host): the
 *    anti-DNS-rebinding check (wsAuth.privilegedHostnames).
 * 3. An Origin, when one is sent, naming an allowed host too: the spec's own
 *    DNS-rebinding rule for browser-originated requests.
 *
 * Read-only: the tools (officeTools.ts) only ever see an OfficeView of getters.
 * GET and DELETE answer 405 -- there is no server-to-client stream and no
 * session to end.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MCP_PATH } from '../constants.js';
import { bearerTokenValid, normalizeHostname } from '../wsAuth.js';
import type { McpServerInfo } from './mcpProtocol.js';
import { handleMcpMessage, supportsProtocolVersion } from './mcpProtocol.js';
import type { OfficeView } from './officeTools.js';
import { OFFICE_INSTRUCTIONS, officeTools } from './officeTools.js';

export interface McpRouteOptions {
  token: string;
  allowedHostnames: ReadonlySet<string>;
  office: OfficeView;
  version: string;
}

/** Why a request is refused, or null when it may through. Pure, for tests. */
export function mcpRequestRefusal(
  headers: { authorization?: string; host?: string; origin?: string },
  token: string,
  allowedHostnames: ReadonlySet<string>,
): { status: 401 | 403; message: string } | null {
  if (!token || !bearerTokenValid(headers.authorization, token)) {
    return { status: 401, message: 'unauthorized' };
  }
  const host = normalizeHostname(headers.host);
  if (host === null || !allowedHostnames.has(host)) {
    return { status: 403, message: 'host not allowed' };
  }
  if (headers.origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = normalizeHostname(new URL(headers.origin).host);
    } catch {
      originHost = null;
    }
    if (originHost === null || !allowedHostnames.has(originHost)) {
      return { status: 403, message: 'origin not allowed' };
    }
  }
  return null;
}

export function registerMcpRoute(app: FastifyInstance, options: McpRouteOptions): void {
  const tools = officeTools(options.office);
  const info: McpServerInfo = {
    name: 'pixel-agents',
    version: options.version || '0.0.0',
    instructions: OFFICE_INSTRUCTIONS,
  };

  app.post<{ Body: unknown }>(MCP_PATH, async (request, reply) => {
    const refused = refusal(request, options);
    if (refused) return reply.code(refused.status).send(refused.message);
    const version = request.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !supportsProtocolVersion(version)) {
      return reply.code(400).send(`unsupported MCP-Protocol-Version: ${version}`);
    }
    const out = handleMcpMessage(request.body, tools, info);
    if (out.status === 202) return reply.code(202).send();
    return reply.code(200).type('application/json').send(out.body);
  });

  const notAllowed = async (request: FastifyRequest, reply: FastifyReply) => {
    const refused = refusal(request, options);
    if (refused) return reply.code(refused.status).send(refused.message);
    return reply.code(405).header('allow', 'POST').send();
  };
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
}

function refusal(request: FastifyRequest, options: McpRouteOptions) {
  const { authorization, host, origin } = request.headers;
  return mcpRequestRefusal(
    { authorization, host, origin: typeof origin === 'string' ? origin : undefined },
    options.token,
    options.allowedHostnames,
  );
}
