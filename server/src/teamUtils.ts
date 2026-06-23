import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * Pure helpers for working with Lead + Teammates relationships.
 *
 * These replace the duplicated filter pattern
 *   `a.leadAgentId === agentId && !a.teamUsesTmux`
 *
 * "Inline teammate": a teammate running in-process with the lead (no separate
 * terminal). These share the lead's `session_id` in hook events, so routing
 * logic needs to redirect those events from the lead to the teammate.
 *
 * "Tmux teammate": a teammate running in a separate tmux pane with its own
 * `session_id`. Hooks route to it directly; no redirection needed.
 */

/** Is this agent an inline teammate (non-tmux) of the given lead? */
export function isInlineTeammateOf(agent: AgentState, leadId: number): boolean {
  return agent.leadAgentId === leadId && !agent.teamUsesTmux;
}

/** All inline teammates of a lead. Returns [id, agent] pairs for convenience. */
export function getInlineTeammates(
  leadId: number,
  agents: AgentStateStore,
): Array<[number, AgentState]> {
  const out: Array<[number, AgentState]> = [];
  for (const [id, a] of agents) {
    if (isInlineTeammateOf(a, leadId)) out.push([id, a]);
  }
  return out;
}

/** Does this lead have any active inline teammates? */
export function hasInlineTeammates(leadId: number, agents: AgentStateStore): boolean {
  for (const a of agents.values()) {
    if (isInlineTeammateOf(a, leadId)) return true;
  }
  return false;
}
