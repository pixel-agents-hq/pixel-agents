import type { AgentWorktree, AgentWorktreeChanged } from '../../core/src/messages.js';
import type { AgentState } from './types.js';

/**
 * The `agentCreated` message announcing an agent to the office: one builder
 * for both surfaces, so a field added here reaches both. `seatId` is the seat
 * a resumed agent asks for (only the standalone launcher sets it).
 */
export function agentCreatedMessage(id: number, agent: AgentState): Record<string, unknown> {
  return {
    type: 'agentCreated',
    id,
    directoryName: agent.directoryName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    repeat: agent.repeat,
    seatId: agent.seatId,
    // The office shows name and branch; the folder stays server-side.
    worktree: officeWorktree(agent),
  };
}

/** An agent's Worktree as the office sees it: name and branch (the folder
 *  stays server-side). */
function officeWorktree(agent: AgentState): AgentWorktree | undefined {
  return agent.worktree && { name: agent.worktree.name, branch: agent.worktree.branch };
}

/** `agentWorktreeChanged`: the agent moved, and now runs in this Worktree
 *  (or in none). */
export function agentWorktreeChangedMessage(id: number, agent: AgentState): AgentWorktreeChanged {
  const worktree = officeWorktree(agent);
  return { type: 'agentWorktreeChanged', id, ...(worktree ? { worktree } : {}) };
}

/**
 * `existingAgents.worktrees`: the Worktree of every agent that runs in one,
 * keyed by id, so a reload or reconnect keeps each card's marker and branch.
 * One builder for both surfaces, like agentCreatedMessage.
 */
export function existingAgentWorktrees(
  agents: Iterable<[number, AgentState]>,
): Record<number, AgentWorktree> {
  const out: Record<number, AgentWorktree> = {};
  for (const [id, agent] of agents) {
    const worktree = officeWorktree(agent);
    if (worktree) out[id] = worktree;
  }
  return out;
}
