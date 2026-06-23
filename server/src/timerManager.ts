import type { AgentStateStore } from './agentStateStore.js';
import { PERMISSION_TIMER_DELAY_MS } from './constants.js';
import type { AgentState } from './types.js';

export function clearAgentActivity(
  agent: AgentState | undefined,
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  if (!agent) return;

  // Preserve background agent tools — only clear foreground state.
  // The subagent maps are keyed by parentToolId; deleting a non-parent key is a
  // safe no-op, so no tool-name check is needed here.
  if (agent.backgroundAgentToolIds.size > 0) {
    for (const toolId of agent.activeToolIds) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
    }
  } else {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
  }

  agent.isWaiting = false;
  agent.permissionSent = false;
  cancelPermissionTimer(agentId, permissionTimers);
  agents.broadcast({ type: 'agentToolsClear', id: agentId });
  // Re-send background agent tools so webview re-creates their sub-agents
  for (const toolId of agent.backgroundAgentToolIds) {
    const status = agent.activeToolStatuses.get(toolId);
    if (status) {
      agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
      });
    }
  }
  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
}

export function cancelWaitingTimer(
  agentId: number,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = waitingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    waitingTimers.delete(agentId);
  }
}

export function startWaitingTimer(
  agentId: number,
  delayMs: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  const timer = setTimeout(() => {
    waitingTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (agent) {
      agent.isWaiting = true;
    }
    agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
    });
  }, delayMs);
  waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = permissionTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    permissionTimers.delete(agentId);
  }
}

export function startPermissionTimer(
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionExemptTools: ReadonlySet<string>,
): void {
  cancelPermissionTimer(agentId, permissionTimers);
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    // Only flag if there are still active non-exempt tools (parent or sub-agent)
    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    // Check sub-agent tools for non-exempt tools
    const stuckSubagentParentToolIds: string[] = [];
    for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subToolNames) {
        if (!permissionExemptTools.has(toolName)) {
          stuckSubagentParentToolIds.push(parentToolId);
          hasNonExempt = true;
          break;
        }
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      console.log(`[Pixel Agents] Timer: Agent ${agentId} - possible permission wait detected`);
      agents.broadcast({
        type: 'agentToolPermission',
        id: agentId,
      });
      // Also notify stuck sub-agents
      for (const parentToolId of stuckSubagentParentToolIds) {
        agents.broadcast({
          type: 'subagentToolPermission',
          id: agentId,
          parentToolId,
        });
      }
    }
  }, PERMISSION_TIMER_DELAY_MS);
  permissionTimers.set(agentId, timer);
}
