import type { FastifyInstance } from 'fastify';

import { bearerTokenValid } from '../wsAuth.js';
import type { PermissionApprovals, PermissionWaitRequest } from './approvalRegistry.js';
import { PERMISSION_WAIT_PATH } from './constants.js';

/** Validate the long-poll body. Returns null for anything malformed. */
export function parsePermissionWaitBody(body: unknown): PermissionWaitRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const { requestId, session_id: sessionId, tool_name: toolName, cwd } = raw;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) {
    return null;
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  return {
    requestId,
    sessionId,
    toolName,
    toolInput: raw.tool_input,
    cwd: typeof cwd === 'string' ? cwd : undefined,
    remote: raw.pixel_source !== undefined,
  };
}

/**
 * `POST /api/permissions/wait`: a local PermissionRequest hook's long-poll.
 * Same Bearer token as the hook route (only local processes hold it). Held
 * open until the request settles; answers `{ decision? }`. A hook that goes
 * away first abandons its request (the board stops offering it).
 */
export function registerPermissionRoutes(
  app: FastifyInstance,
  options: { token: string; approvals: PermissionApprovals },
): void {
  app.post(PERMISSION_WAIT_PATH, async (request, reply) => {
    if (!bearerTokenValid(request.headers.authorization, options.token)) {
      return reply.code(401).send('unauthorized');
    }
    const parsed = parsePermissionWaitBody(request.body);
    if (!parsed) return reply.code(400).send({});
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) options.approvals.abandon(parsed.requestId);
    });
    const result = await options.approvals.wait(parsed);
    return reply.send(result);
  });
}
