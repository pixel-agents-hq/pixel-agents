// webview-ui/src/agentCurators.tsx
//
// Hands the curator state to every agent card without threading props through
// each card bar. The default value is "unavailable": a card rendered outside a
// provider (or under VS Code) shows no curator control and no badge.

import { createContext, useContext } from 'react';

import type { ClientMessage } from '../../core/src/messages.js';
import type { CuratorState } from './curators.js';
import { INITIAL_CURATORS } from './curators.js';
import { DEFAULT_WORKSPACE_ID } from './workspaces.js';

export interface AgentCuratorsValue {
  state: CuratorState;
  /** The Workspace an agent belongs to (the default's id when none). */
  workspaceOf: (agentId: number) => string;
  /** Send a curator request from an agent's card. */
  request: (agentId: number, message: ClientMessage) => void;
}

const AgentCuratorsContext = createContext<AgentCuratorsValue>({
  state: INITIAL_CURATORS,
  workspaceOf: () => DEFAULT_WORKSPACE_ID,
  request: () => {},
});

export const AgentCuratorsProvider = AgentCuratorsContext.Provider;

export function useAgentCurators(): AgentCuratorsValue {
  return useContext(AgentCuratorsContext);
}
