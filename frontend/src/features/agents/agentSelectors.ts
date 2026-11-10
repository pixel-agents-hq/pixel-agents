import { createSelector } from '@reduxjs/toolkit';

import type { RootState } from '../../app/store';
import type { Agent, SubagentActivity, ToolActivity } from './agentsSlice';

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

/** 主程序自己進行中的工具；子代理與背景工具另外呈現，這裡不重複列出。 */
export function foregroundTools(agent: Agent): ToolActivity[] {
  const subagentToolIds = new Set(agent.subagents.map((subagent) => subagent.parentToolId));
  return activeTools(agent).filter(
    (tool) => tool.runInBackground !== true && !subagentToolIds.has(tool.toolId),
  );
}

/** 背景執行中的工具；子代理本身由 subagents 呈現，這裡不重複列出。 */
export function backgroundTools(agent: Agent): ToolActivity[] {
  const subagentToolIds = new Set(agent.subagents.map((subagent) => subagent.parentToolId));
  return activeTools(agent).filter(
    (tool) => tool.runInBackground === true && !subagentToolIds.has(tool.toolId),
  );
}

/** 子代理的標題：沿用派出它的那個工具呼叫的狀態文字。 */
export function subagentLabel(agent: Agent, subagent: SubagentActivity): string {
  return agent.tools.find((tool) => tool.toolId === subagent.parentToolId)?.status ?? '子代理';
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
