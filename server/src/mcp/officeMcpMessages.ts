/**
 * The office's Pixel Office MCP messages, answered the same on both surfaces
 * (the composed feature's handleMessage, for /ws offices and VS Code's
 * webview alike): the consent (the Intro step) and the Settings switches — each an
 * absolute state, one config write, every office hearing the result; turning
 * it off revokes every agent's access at once — and the layout editor's
 * editing lock and "Undo <agent>'s edit".
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import type { LayoutEdits } from './layoutEdits.js';
import type { OfficeMcp } from './officeMcp.js';

export interface OfficeMcpMessageContext {
  officeMcp: OfficeMcp;
  layoutEdits: LayoutEdits;
  /** The office sending it, as the editing lock keys it (absent: no lock report). */
  client?: object;
  /** To every office. */
  broadcast(message: ServerMessage): void;
  /** To the sending office alone. */
  reply(message: ServerMessage): void;
}

/** Answer `msg` when it is one of these messages; false otherwise. */
export function handleOfficeMcpMessage(
  msg: Record<string, unknown>,
  ctx: OfficeMcpMessageContext,
): boolean {
  const { officeMcp, layoutEdits } = ctx;
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
    case 'layoutEditing':
      // The editor has (or no longer has) unsaved changes: agents' edits wait for it.
      if (ctx.client && typeof msg.dirty === 'boolean') {
        layoutEdits.setEditing(ctx.client, msg.dirty);
      }
      return true;
    case 'undoAgentLayoutEdit': {
      // The same undo as undo_layout_edit. A refusal is answered to this office
      // alone; a success reaches every office as a layout broadcast.
      const outcome = layoutEdits.undo();
      if (!outcome.ok) ctx.reply({ ...layoutEdits.statusMessage(), refused: outcome.reason });
      return true;
    }
    default:
      return false;
  }
}
