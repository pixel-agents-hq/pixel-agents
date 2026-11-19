import { useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';
import { agentCharacterEditEntry, subscribeAgentCharacterEdits } from './agentCharacterEdits.js';
import type { AgentEditEntry } from './agentEditStatus.js';

export interface AgentCharacterEditControls {
  /** The latest status: a new entry per message, so each landing or refusal can show once. */
  entry: AgentEditEntry;
  /** The Characters view's "Undo <agent>'s edit": the server undoes it, or answers why not. */
  undo: () => void;
}

const undo = () => transport.send({ type: 'undoAgentCharacterEdit' });

/** Agents' Character edits in this office (agentCharacterEdits.ts): the undo button's state. */
export function useAgentCharacterEdits(): AgentCharacterEditControls {
  const entry = useSyncExternalStore(subscribeAgentCharacterEdits, agentCharacterEditEntry);
  return { entry, undo };
}
