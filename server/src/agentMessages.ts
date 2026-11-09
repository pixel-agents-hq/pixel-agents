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
  };
}
