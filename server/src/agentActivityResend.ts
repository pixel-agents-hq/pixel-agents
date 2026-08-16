import type { AgentStateStore } from './agentStateStore.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';

/**
 * Replay an agent's active state to a connecting client.
 *
 * Order matters:
 * 1. Team info first — webview needs team context before tool messages
 * 2. Regular tools
 * 3. Background tools with runInBackground + isTeammateSpawn flags, skipping promoted spawns
 * 4. Waiting status
 * 5. Context usage
 */
export function resendAgentActivity(
  send: (message: Record<string, unknown>) => void,
  store: AgentStateStore,
): void {
  for (const [id, agent] of store) {
    // 1. Team metadata first — webview uses this to route tool messages correctly.
    // Derived teams (named background spawns) have a name and a lead link but NO
    // teamName, so gate on any team field.
    if (agent.teamName || agent.agentName || agent.isTeamLead) {
      send({
        type: 'agentTeamInfo',
        id,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }

    // 2. Regular (non-background) tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      // Skip background tools here — they're sent separately below with proper flags
      if (agent.backgroundAgentToolIds.has(toolId)) continue;

      const toolName = agent.activeToolNames.get(toolId) ?? '';
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
      });
    }

    // 3. Background tools with runInBackground flag. Skip promoted spawns to prevent
    // ghost Subtask characters alongside the real teammate character.
    for (const toolId of agent.backgroundAgentToolIds) {
      if (hasPromotedBackgroundAgent(id, toolId, store)) continue;

      const status = agent.activeToolStatuses.get(toolId);
      if (!status) continue;

      const toolName = agent.activeToolNames.get(toolId);
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }

    // 4. Waiting status
    if (agent.isWaiting) {
      send({
        type: 'agentStatus',
        id,
        status: 'waiting',
      });
    }

    // 5. Context usage
    if (agent.contextTokens > 0) {
      send({
        type: 'agentContextUsage',
        id,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }

    // 6. Task board. The list is NOT persisted to disk on purpose — a board
    // reloaded from a previous run describes a turn that already ended. But a
    // reconnect is not a new session: this process still holds the list the
    // agent published, and the client that just dropped is the only thing that
    // forgot it. Resending is what makes the board survive a panel reload
    // instead of staying blank until the agent's next revision.
    //
    // Empty is not sent: an agent with no board and an agent whose board was
    // retracted look the same to a fresh client, and `agentTasks: []` is the
    // retraction message — replaying it would be a statement about a board the
    // client never had.
    if (agent.tasks && agent.tasks.length > 0) {
      send({
        type: 'agentTasks',
        id,
        tasks: agent.tasks,
        // Not a revision: the agent published this list earlier and has not
        // touched it since. Marks it so the office does not send every agent
        // walking to the whiteboard on reconnect.
        replay: true,
      });
    }
  }
}
