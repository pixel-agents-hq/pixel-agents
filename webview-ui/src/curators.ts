// webview-ui/src/curators.ts
//
// Workspace curators as the office sees them: pure state and decisions, so the
// rules are testable without a browser (same shape as roleLaunch / workspaces).
//
// The host is the authority. `curatorsLoaded.available` says whether this host
// supports curators at all; it is false (or never sent) in the VS Code panel
// and in any embedded host, and a read-only office never shows the controls
// either. A standalone host appoints any PTY agent of the Workspace (no
// capability needed); an external or restored agent is answered `not_eligible`.

import type {
  ClientMessage,
  CuratorRejected,
  CuratorsLoaded,
  WorkspaceCuratorChanged,
} from '../../core/src/messages.js';

export interface CuratorRejection {
  /** The agent whose card sent the refused request (null if unknown). */
  agentId: number | null;
  reason: string;
}

export interface CuratorState {
  available: boolean;
  /** Workspace id -> curator agent id. */
  byWorkspace: Record<string, number>;
  /** Card that sent the last request still unanswered by a change. */
  pendingAgentId: number | null;
  /** Last refusal, shown as plain text on the requesting card. */
  rejection: CuratorRejection | null;
}

export const INITIAL_CURATORS: CuratorState = {
  available: false,
  byWorkspace: {},
  pendingAgentId: null,
  rejection: null,
};

/** A fresh handshake replaces everything this office knew. */
export function applyCuratorsLoaded(msg: CuratorsLoaded): CuratorState {
  const byWorkspace: Record<string, number> = {};
  if (msg.available === true && Array.isArray(msg.curators)) {
    for (const entry of msg.curators) {
      if (typeof entry?.workspaceId === 'string' && Number.isSafeInteger(entry.agentId)) {
        byWorkspace[entry.workspaceId] = entry.agentId;
      }
    }
  }
  return { ...INITIAL_CURATORS, available: msg.available === true, byWorkspace };
}

export function applyWorkspaceCuratorChanged(
  state: CuratorState,
  msg: WorkspaceCuratorChanged,
): CuratorState {
  if (typeof msg.workspaceId !== 'string') return state;
  const byWorkspace = { ...state.byWorkspace };
  if (typeof msg.agentId === 'number' && Number.isSafeInteger(msg.agentId)) {
    byWorkspace[msg.workspaceId] = msg.agentId;
  } else {
    delete byWorkspace[msg.workspaceId];
  }
  return { ...state, byWorkspace, pendingAgentId: null, rejection: null };
}

export function applyCuratorRejected(state: CuratorState, msg: CuratorRejected): CuratorState {
  if (typeof msg.reason !== 'string') return state;
  return {
    ...state,
    pendingAgentId: null,
    rejection: { agentId: state.pendingAgentId, reason: msg.reason },
  };
}

/** The office sent a request from this agent's card. */
export function noteCuratorRequest(state: CuratorState, agentId: number): CuratorState {
  return { ...state, pendingAgentId: agentId, rejection: null };
}

/** Controls appear only on a host that supports curators, for a privileged office. */
export function curatorControlsVisible(state: CuratorState, readOnly: boolean): boolean {
  return state.available && !readOnly;
}

/** Whether this agent is the curator of the Workspace it belongs to. */
export function isCuratorOf(state: CuratorState, agentId: number, workspaceId: string): boolean {
  return state.byWorkspace[workspaceId] === agentId;
}

export type CuratorCardAction =
  | { kind: 'none' }
  | { kind: 'appoint'; message: ClientMessage }
  | { kind: 'dismiss'; message: ClientMessage };

/**
 * What the agent card offers: dismiss for the current curator, appoint for an
 * agent whose Workspace has none, nothing otherwise (or when hidden).
 */
export function curatorCardAction(
  state: CuratorState,
  readOnly: boolean,
  agentId: number,
  workspaceId: string,
): CuratorCardAction {
  if (!curatorControlsVisible(state, readOnly)) return { kind: 'none' };
  const current = state.byWorkspace[workspaceId];
  if (current === agentId) {
    return { kind: 'dismiss', message: { type: 'unsetWorkspaceCurator', workspaceId } };
  }
  if (current !== undefined) return { kind: 'none' };
  return { kind: 'appoint', message: { type: 'setWorkspaceCurator', workspaceId, agentId } };
}

/** The refusal to show on this agent's card, if it is the one that asked. */
export function curatorRejectionFor(state: CuratorState, agentId: number): string | null {
  return state.rejection && state.rejection.agentId === agentId ? state.rejection.reason : null;
}
