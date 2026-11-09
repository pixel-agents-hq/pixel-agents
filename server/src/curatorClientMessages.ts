/**
 * The curator client messages: setWorkspaceCurator / unsetWorkspaceCurator,
 * and the curatorsLoaded handshake reply.
 *
 * Both requests are privileged; a read-only client never reaches here (the
 * refuseReadOnly gate in clientMessageHandler drops them without a reply).
 * The wire schema is not enforced at runtime, so every field is checked here.
 * A success is broadcast by the CuratorTable (workspaceCuratorChanged, ids
 * only); a refusal answers the sender alone with a fixed reason string.
 */

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { CuratorRejectionCode as WireCuratorRejectionCode } from '../../core/src/messages.js';
import type { AgentRuntime } from './agentRuntime.js';
import { workspaceKeyExists } from './capabilities.js';
import {
  CURATOR_EXISTS_REASON,
  CURATOR_INVALID_REASON,
  CURATOR_NOT_ELIGIBLE_REASON,
  CURATOR_UNAVAILABLE_REASON,
  WORKSPACE_ID_MAX_LENGTH,
} from './constants.js';
import type { CuratorTable } from './curators.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';

const REASONS: Record<WireCuratorRejectionCode, string> = {
  invalid: CURATOR_INVALID_REASON,
  exists: CURATOR_EXISTS_REASON,
  not_eligible: CURATOR_NOT_ELIGIBLE_REASON,
  unavailable: CURATOR_UNAVAILABLE_REASON,
};

/** The `curatorRejected` reply for a code; the reason is always the fixed one. */
export function curatorRejectedMessage(code: WireCuratorRejectionCode): Record<string, unknown> {
  return { type: 'curatorRejected', code, reason: REASONS[code] };
}

/**
 * What decides availability: a standalone host (ptyManager) with a runtime and
 * a curator table. VS Code embedded /ws has none.
 *
 * P2 decoupled curators from KB enablement: eligibility is "a known standalone
 * agent of that Workspace" (curators.ts), so neither a capability registry nor
 * isKbEnabled gates availability any more, and curatorsLoaded.available is this
 * answer alone. The curatorsLoaded message itself is unchanged (same fields).
 */
export interface CuratorHost {
  runtime?: AgentRuntime;
  ptyManager?: PtySessionManager;
  curators?: CuratorTable;
}

export function curatorsAvailable(host: CuratorHost): boolean {
  return host.ptyManager !== undefined && host.runtime !== undefined && host.curators !== undefined;
}

/** The handshake reply: every current curator, ids only. */
export function curatorsLoadedMessage(
  available: boolean,
  curators: CuratorTable | undefined,
): Record<string, unknown> {
  return {
    type: 'curatorsLoaded',
    available,
    curators: available && curators ? curators.list() : [],
  };
}

export interface CuratorMessageDeps {
  available: boolean;
  curators: CuratorTable | undefined;
  /** Point-to-point reply to the requesting client. */
  reply: (message: Record<string, unknown>) => void;
}

/** A Workspace id naming an existing Workspace (the default always exists). */
function validWorkspaceId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > WORKSPACE_ID_MAX_LENGTH) return false;
  return value === DEFAULT_WORKSPACE_ID || workspaceKeyExists(value);
}

/** A positive safe-integer agent id; strings, NaN, 0 and negatives are not. */
function validAgentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Dispatch the two curator requests. Returns false for any other message. */
export function handleCuratorClientMessage(
  msg: Record<string, unknown>,
  deps: CuratorMessageDeps,
): boolean {
  if (msg.type !== 'setWorkspaceCurator' && msg.type !== 'unsetWorkspaceCurator') return false;

  const { curators } = deps;
  if (!deps.available || !curators) {
    deps.reply(curatorRejectedMessage('unavailable'));
    return true;
  }
  if (!validWorkspaceId(msg.workspaceId)) {
    deps.reply(curatorRejectedMessage('invalid'));
    return true;
  }

  if (msg.type === 'unsetWorkspaceCurator') {
    const result = curators.dismiss(msg.workspaceId);
    if (!result.ok) deps.reply(curatorRejectedMessage(result.code));
    return true;
  }

  if (!validAgentId(msg.agentId)) {
    deps.reply(curatorRejectedMessage('invalid'));
    return true;
  }
  const result = curators.appoint(msg.workspaceId, msg.agentId);
  if (!result.ok) deps.reply(curatorRejectedMessage(result.code));
  return true;
}
