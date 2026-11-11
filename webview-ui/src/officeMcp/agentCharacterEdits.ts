/**
 * Agents' Character edits as this office takes part in them (agentEditStatus.ts):
 * what the Characters view's "Undo <agent>'s edit" would revert, the edit that
 * just landed (named in the view's status line), and the reason a press of the
 * button was refused. The view's editing-lock report lives with the cast
 * (characters/castStore.ts).
 */

import { type AgentEditEntry, createAgentEditStatus } from './agentEditStatus.js';

const status = createAgentEditStatus('agentCharacterEditStatus');

/** Take an agentCharacterEditStatus (useExtensionMessages). Returns whether it was one. */
export const handleAgentCharacterEditMessage = status.handle;
export const agentCharacterEditEntry = status.entry;
export const subscribeAgentCharacterEdits = status.subscribe;
/** Tests only: forget everything. */
export const resetAgentCharacterEditsForTests = status.reset;

/** What the view's status line says for an entry: a refusal (error), an edit that
 *  landed ("Spike created Naruto"), or nothing. */
export function statusLineFor(e: AgentEditEntry): { text: string; kind: 'ok' | 'err' } | null {
  if (e.refused) return { text: e.refused, kind: 'err' };
  if (e.landed) return { text: e.landed, kind: 'ok' };
  return null;
}
