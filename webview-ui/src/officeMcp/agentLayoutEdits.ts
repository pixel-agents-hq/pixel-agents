/**
 * Agents' layout edits as this office takes part in them (agentEditStatus.ts):
 *
 * - what the editor's "Undo <agent>'s edit" would revert (agentLayoutEditStatus:
 *   the newest agent edit while the office still holds what it wrote; nothing
 *   = no button), and the reason a press of it was refused;
 * - this office's report to the editing lock (layoutEditing): while its editor
 *   holds unsaved changes, agents' edits wait. Sent only when it changes, and
 *   again after a reconnect (the server drops a closed socket's report).
 */

import type { ClientMessage } from '../../../core/src/messages.js';
import { type AgentEditEntry, createAgentEditStatus } from './agentEditStatus.js';
import { createEditingReporter } from './editingReporter.js';

export { undoButtonLabel } from './agentEditStatus.js';
export type AgentLayoutEditEntry = AgentEditEntry;

const status = createAgentEditStatus('agentLayoutEditStatus');

/** Take an agentLayoutEditStatus (useExtensionMessages). Returns whether it was one. */
export const handleAgentLayoutEditMessage = status.handle;
export const agentLayoutEditEntry = status.entry;
export const subscribeAgentLayoutEdits = status.subscribe;
/** Tests only: forget everything. */
export const resetAgentLayoutEditsForTests = status.reset;

/** This office's layout editing-lock report: `report` on every change of "editor open
 *  with unsaved changes", `reconnected` after the socket came back. */
export function createLayoutEditingReporter(send: (msg: ClientMessage) => void): {
  report(dirty: boolean): void;
  reconnected(): void;
} {
  return createEditingReporter('layoutEditing', send);
}
