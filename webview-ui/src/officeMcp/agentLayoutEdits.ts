/**
 * Agents' layout edits as this office takes part in them, outside React (like
 * officeMcpStore.ts):
 *
 * - what the editor's "Undo <agent>'s edit" would revert (agentLayoutEditStatus:
 *   the newest agent edit while the office still holds what it wrote; nothing
 *   = no button), and the reason a press of it was refused;
 * - this office's report to the editing lock (layoutEditing): while its editor
 *   holds unsaved changes, agents' edits wait. Sent only when it changes, and
 *   again after a reconnect (the server drops a closed socket's report).
 */

import type { ClientMessage } from '../../../core/src/messages.js';

export interface AgentLayoutEditEntry {
  /** The agent whose edit an undo would revert, or null when there is none. */
  undoable: { agentId: number; agentName: string } | null;
  /** Why this office's last undo press was refused, until the next status. */
  refused: string | null;
}

const EMPTY: AgentLayoutEditEntry = { undoable: null, refused: null };
let entry: AgentLayoutEditEntry = EMPTY;
const listeners = new Set<() => void>();

/** Take an agentLayoutEditStatus (useExtensionMessages). Returns whether it was one. */
export function handleAgentLayoutEditMessage(msg: {
  type?: unknown;
  [key: string]: unknown;
}): boolean {
  if (msg.type !== 'agentLayoutEditStatus') return false;
  const undoable =
    typeof msg.agentId === 'number'
      ? {
          agentId: msg.agentId,
          agentName: typeof msg.agentName === 'string' ? msg.agentName : `agent ${msg.agentId}`,
        }
      : null;
  update({ undoable, refused: typeof msg.refused === 'string' ? msg.refused : null });
  return true;
}

/** The editor button's label, or null when there is nothing to undo. */
export function undoButtonLabel(e: AgentLayoutEditEntry): string | null {
  return e.undoable ? `Undo ${e.undoable.agentName}'s edit` : null;
}

export function agentLayoutEditEntry(): AgentLayoutEditEntry {
  return entry;
}

export function subscribeAgentLayoutEdits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: AgentLayoutEditEntry): void {
  entry = next;
  for (const l of listeners) l();
}

/** Tests only: forget everything. */
export function resetAgentLayoutEditsForTests(): void {
  entry = EMPTY;
}

/** This office's editing-lock report: `report` on every change of "editor open
 *  with unsaved changes", `reconnected` after the socket came back. */
export function createLayoutEditingReporter(send: (msg: ClientMessage) => void): {
  report(dirty: boolean): void;
  reconnected(): void;
} {
  let sent = false;
  return {
    report(dirty) {
      if (dirty === sent) return;
      sent = dirty;
      send({ type: 'layoutEditing', dirty });
    },
    reconnected() {
      // The server forgot this office's report with its old socket.
      if (sent) send({ type: 'layoutEditing', dirty: true });
    },
  };
}
