import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';
import { onReconnect } from '../transport/onReconnect.js';
import {
  type AgentLayoutEditEntry,
  agentLayoutEditEntry,
  createLayoutEditingReporter,
  subscribeAgentLayoutEdits,
} from './agentLayoutEdits.js';

export interface AgentLayoutEditControls extends AgentLayoutEditEntry {
  /** The editor's "Undo <agent>'s edit": the server undoes it, or answers why not. */
  undo: () => void;
}

/**
 * Agents' layout edits in this office (agentLayoutEdits.ts): reports `editing`
 * — the layout editor open with unsaved changes — to the server's editing lock
 * whenever it changes (and after a reconnect), and exposes the undo button's state.
 */
export function useAgentLayoutEdits(editing: boolean): AgentLayoutEditControls {
  const entry = useSyncExternalStore(subscribeAgentLayoutEdits, agentLayoutEditEntry);
  const reporter = useMemo(() => createLayoutEditingReporter((m) => transport.send(m)), []);
  useEffect(() => reporter.report(editing), [reporter, editing]);
  useEffect(() => onReconnect(transport, () => reporter.reconnected()), [reporter]);
  return { ...entry, undo: () => transport.send({ type: 'undoAgentLayoutEdit' }) };
}
