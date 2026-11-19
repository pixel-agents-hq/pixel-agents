/**
 * Who is in the office, as the Pixel Office MCP describes them (list_agents):
 * every main agent with its status, activity, context, seat, Visit and
 * character, read from the store and one office snapshot.
 */

import { getCharacterProfiles } from '../characterProfilesStore.js';
import { hasPromotedBackgroundAgent } from '../teamUtils.js';
import type { AgentState } from '../types.js';
import { currentVisit } from '../visits.js';
import { type OfficeFacts, officeSnapshot } from './officeFacts.js';
import type { AgentsView, OfficeAgent, OfficeAgentStatus } from './officeOperations.js';

/** An agent's status as every office shows it: its permission bubble, else its turn. */
export function statusOf(
  agent: Pick<AgentState, 'permissionSent' | 'turnStatus'>,
): OfficeAgentStatus {
  return agent.permissionSent ? 'permission request' : agent.turnStatus;
}

/** The character an agent wears: the roster label and palette index (plus which copy). */
export function characterOf(agent: AgentState): OfficeAgent['character'] {
  if (agent.palette === undefined) return null;
  const profile = getCharacterProfiles()[agent.palette];
  return { label: profile?.name ?? null, palette: agent.palette, repeat: agent.repeat ?? 0 };
}

export function createAgentsView(
  facts: OfficeFacts,
  /** Whether an agent has a terminal of ours a Message could be typed into. */
  messageable: (agentId: number) => boolean,
): AgentsView {
  const { store, provider } = facts;

  function activityOf(agent: AgentState): string | null {
    let latest: string | null = null;
    for (const status of agent.activeToolStatuses.values()) latest = status;
    return latest;
  }

  function subagentsRunning(agent: AgentState): number {
    const spawns = new Set<string>();
    for (const [toolId, name] of agent.activeToolNames) {
      if (provider.subagentToolNames.has(name)) spawns.add(toolId);
    }
    for (const toolId of agent.backgroundSpawns.keys()) spawns.add(toolId);
    // A named background spawn became a Teammate: an agent of its own, not a sub-agent.
    let count = 0;
    for (const toolId of spawns) {
      if (!hasPromotedBackgroundAgent(agent.id, toolId, store)) count++;
    }
    return count;
  }

  function contextOf(agent: AgentState): OfficeAgent['context'] {
    if (agent.contextTokens <= 0 && !agent.contextReported) return null;
    const windowTokens = agent.maxContextTokens;
    const used = windowTokens > 0 ? Math.min(1, agent.contextTokens / windowTokens) : 0;
    return {
      leftShare: Math.round((1 - used) * 1000) / 1000,
      usedTokens: agent.contextTokens,
      windowTokens,
    };
  }

  function titleOf(agent: AgentState): string | null {
    try {
      return provider.conversationTitle?.(agent.jsonlFile) ?? null;
    } catch {
      return null; // no transcript yet
    }
  }

  return {
    hasAgent: (id) => store.has(id),

    listAgents() {
      const office = officeSnapshot(facts);
      const directories = facts.directories();
      const agents: OfficeAgent[] = [];
      for (const [id, agent] of store) {
        const directory = agent.directoryName
          ? {
              name: agent.directoryName,
              path: directories.find((d) => d.name === agent.directoryName)?.path ?? null,
            }
          : null;
        const seatId = office.seatOf(id);
        const place = seatId ? office.seats.get(seatId) : undefined;
        const visit = currentVisit(agent);
        const teammates: OfficeAgent['teammates'] = [];
        for (const [otherId, other] of store) {
          if (other.leadAgentId === id)
            teammates.push({ id: otherId, name: other.agentName ?? null });
        }
        agents.push({
          id,
          nickname: agent.nickname ?? null,
          directory,
          workingDirectory: agent.cwd ?? agent.worktree?.path ?? directory?.path ?? null,
          worktree: agent.worktree
            ? { name: agent.worktree.name, branch: agent.worktree.branch }
            : null,
          status: statusOf(agent),
          activity: activityOf(agent),
          subagentsRunning: subagentsRunning(agent),
          context: contextOf(agent),
          conversationTitle: titleOf(agent),
          transcriptPath: agent.jsonlFile,
          leadId: agent.leadAgentId ?? null,
          teammates,
          seat: seatId
            ? { id: seatId, tile: place?.tile ?? null, area: place?.area ?? null }
            : null,
          atDesk: !visit,
          visit: visit ? { tile: visit.to, facing: visit.facing, stay: visit.stay } : null,
          character: characterOf(agent),
          messageable: messageable(id),
        });
      }
      return agents;
    },
  };
}
