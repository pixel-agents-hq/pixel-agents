import type { AgentStateStore } from './agentStateStore.js';
import { getFunServices } from './fun/funServices.js';
import { getInboxTracker } from './inbox/inboxTracker.js';
import { getLocalSessionWatcher } from './localSessions.js';
import { getSignalsHub } from './signals/registry.js';
import { getTaskLedger } from './tasks/taskLedger.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';
import { getProgressTracker } from './transcriptParser.js';
import { getUsageMeter } from './usage/usageMeter.js';

/**
 * Replay an agent's active state to a connecting client.
 *
 * Order matters:
 * 1. Team info first — webview needs team context before tool messages
 * 2. Regular tools
 * 3. Background tools with runInBackground + isTeammateSpawn flags, skipping promoted spawns
 * 4. Waiting status
 * 5. Context usage
 * Then, once for the office: today's task log (tasksSnapshot), the inbox's links
 * and pauses, every agent's
 * stage track and today's totals, and an agentSleep for each sleeping agent.
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
  }

  // The week wall's totals and the weather (see fun/funServices.ts), found the
  // same way as the progress below.
  const fun = getFunServices();
  if (fun?.tracks(store)) {
    for (const message of fun.snapshot()) {
      send({ ...message });
    }
  }

  // The Manager's task log for today (tasks/taskLedger.ts). Looked up here
  // rather than passed in, so both surfaces' resends carry it.
  const tasks = getTaskLedger();
  if (tasks?.tracks(store)) {
    send({ ...tasks.snapshot() });
  }

  // Needs-you inbox (inbox/inboxTracker.ts): every agent's agentLink, then an
  // agentLimit for each agent paused by a usage limit right now. Looked up here
  // rather than passed in, so both surfaces' resends carry it.
  const inbox = getInboxTracker();
  if (inbox?.tracks(store)) {
    for (const message of inbox.snapshot()) {
      send({ ...message });
    }
  }

  // Work progress: an agentProgress per agent, then dailyStats. Looked up the
  // same way.
  const progress = getProgressTracker();
  if (progress?.tracks(store)) {
    for (const message of progress.snapshot()) {
      send({ ...message });
    }
  }

  // Sleeping agents (idle open sessions, see localSessions.ts). Looked up the
  // same way; only agents asleep right now are sent -- awake is the default.
  const sleep = getLocalSessionWatcher();
  if (sleep?.tracks(store)) {
    for (const message of sleep.snapshot()) {
      send({ ...message });
    }
  }

  // The server room's usage meter: the subscription's 5-hour / 7-day usage,
  // once a status line has reported it.
  const usage = getUsageMeter();
  if (usage?.tracks(store)) {
    for (const message of usage.snapshot()) {
      send({ ...message });
    }
  }

  // Useful signals: trouble and loops in force, today's tokens, the notice board.
  const signals = getSignalsHub();
  if (signals?.tracks(store)) {
    for (const message of signals.snapshot()) {
      send({ ...message });
    }
  }
}
