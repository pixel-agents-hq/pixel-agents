/**
 * The office's Pixel Office MCP messages, answered the same on both surfaces
 * (the composed feature's handleMessage, for /ws offices and VS Code's
 * webview alike): the consent (the Intro step) and the Settings switches — each an
 * absolute state, one config write, every office hearing the result; turning
 * it off revokes every agent's access at once.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import type { OfficeMcp } from './officeMcp.js';

export interface OfficeMcpMessageContext {
  officeMcp: OfficeMcp;
  /** To every office. */
  broadcast(message: ServerMessage): void;
}

/** Answer `msg` when it is one of these messages; false otherwise. */
export function handleOfficeMcpMessage(
  msg: Record<string, unknown>,
  ctx: OfficeMcpMessageContext,
): boolean {
  const { officeMcp } = ctx;
  switch (msg.type) {
    case 'officeMcpConsentResponse': {
      const answer =
        msg.choice === 'allow' ? 'granted' : msg.choice === 'decline' ? 'declined' : null;
      if (answer) ctx.broadcast(officeMcp.answer(answer));
      return true;
    }
    case 'setOfficeMcpEnabled':
      if (typeof msg.enabled === 'boolean') {
        ctx.broadcast(officeMcp.answer(msg.enabled ? 'granted' : 'declined'));
      }
      return true;
    case 'setOfficeMcpReadOnly':
      if (typeof msg.readOnly === 'boolean') {
        ctx.broadcast(officeMcp.setReadOnly(msg.readOnly));
      }
      return true;
    default:
      return false;
  }
}
