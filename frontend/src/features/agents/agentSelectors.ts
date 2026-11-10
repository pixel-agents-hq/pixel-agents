import { createSelector } from '@reduxjs/toolkit';

import type { RootState } from '../../app/store';
import type { Agent, ToolActivity } from './agentsSlice';

export type AgentRunState = 'running' | 'waiting' | 'idle' | 'stopped';

/**
 * 還沒啟用的紀錄是 stopped。其餘協定只有 active 與 waiting：
 * waiting 且 awaitingInput 為真是等使用者，否則是該回合已完成（協定描述為 "Done"）。
 */
export function deriveRunState(agent: Agent): AgentRunState {
  if (agent.stopped) return 'stopped';
  if (agent.status === 'active') return 'running';
  if (agent.awaitingInput || agent.permissionPending) return 'waiting';
  return 'idle';
}

export const RUN_STATE_LABELS: Record<AgentRunState, string> = {
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  stopped: '未啟用',
};

export function agentDisplayName(agent: Agent): string {
  return agent.name ?? agent.directoryName ?? `agent-${agent.id}`;
}

export function activeTools(agent: Agent): ToolActivity[] {
  return agent.tools.filter((tool) => !tool.done);
}

const selectAgentsById = (state: RootState) => state.agents.byId;
const selectAgentOrder = (state: RootState) => state.agents.order;

export const selectAllAgents = createSelector([selectAgentsById, selectAgentOrder], (byId, order) =>
  order.map((id) => byId[id]).filter((agent): agent is Agent => agent !== undefined),
);

export const selectAgentsInWorkspace = createSelector(
  [selectAllAgents, (_state: RootState, workspaceId: string) => workspaceId],
  (agents, workspaceId) => agents.filter((agent) => agent.workspaceId === workspaceId),
);

export const selectAgent = (state: RootState, agentId: number): Agent | undefined =>
  state.agents.byId[agentId];
