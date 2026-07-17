/**
 * Pure derivation of a floor's department board data from live agent state.
 * No React, no rendering — DepartmentBoard.tsx renders whatever this returns.
 *
 * Three lists, not a partition: an agent can appear in more than one (e.g. a
 * seated agent that's both mid-tool and waiting on a permission prompt).
 *   - staff: every non-subagent character seated on this floor
 *   - helpWanted: staff currently blocked on a permission prompt
 *   - openItems: staff currently running a tool
 */

import { getAgentActivityText } from './toolUtils.js';
import type { Character, RosterEntry, ToolActivity } from './types.js';

export interface DepartmentBoardEntry {
  id: number;
  label: string;
  statusText: string;
}

/** A roster entry merged with live-running status: still shown when idle
 *  (isLive: false, no statusText), swapped to the real character's live
 *  status the moment that subagent_type is actually spawned on this floor. */
export interface RosterBoardEntry extends DepartmentBoardEntry {
  skill: string;
  isLive: boolean;
}

export interface DepartmentBoardData {
  staff: DepartmentBoardEntry[];
  helpWanted: DepartmentBoardEntry[];
  openItems: DepartmentBoardEntry[];
  roster: RosterBoardEntry[];
}

const byId = (a: DepartmentBoardEntry, b: DepartmentBoardEntry): number => a.id - b.id;

/** Synthetic ids for idle roster entries: well outside the range of real
 *  character ids (positive for real agents, small negative for live
 *  subagents per subagentIdMap) so they can never collide. */
const ROSTER_ID_OFFSET = -1_000_000;

export function deriveDepartmentBoard(
  characters: Map<number, Character>,
  floorId: string,
  agentTools: Record<number, ToolActivity[]>,
  roster: RosterEntry[] = [],
): DepartmentBoardData {
  const staff: DepartmentBoardEntry[] = [];
  const helpWanted: DepartmentBoardEntry[] = [];
  const openItems: DepartmentBoardEntry[] = [];
  const liveByType = new Map<string, Character>();

  for (const ch of characters.values()) {
    if (ch.floorId !== floorId) continue;
    if (ch.isSubagent && ch.subagentType && !liveByType.has(ch.subagentType)) {
      liveByType.set(ch.subagentType, ch);
    }
    if (ch.isSubagent) continue;

    const label = ch.name ?? ch.agentName ?? `Agent ${ch.id}`;
    const statusText = getAgentActivityText(
      ch.id,
      agentTools,
      ch.isActive,
      ch.bubbleType,
      ch.waitingAwaitingInput ?? false,
    );
    const entry: DepartmentBoardEntry = { id: ch.id, label, statusText };

    staff.push(entry);
    if (ch.bubbleType === 'permission') helpWanted.push(entry);
    if (agentTools[ch.id]?.some((t) => !t.done)) openItems.push(entry);
  }

  const rosterEntries: RosterBoardEntry[] = roster.map((r, index) => {
    const live = liveByType.get(r.subagentType);
    if (live) {
      return {
        id: live.id,
        label: r.displayName,
        skill: r.skill,
        isLive: true,
        statusText: getAgentActivityText(
          live.id,
          agentTools,
          live.isActive,
          live.bubbleType,
          live.waitingAwaitingInput ?? false,
        ),
      };
    }
    return {
      id: ROSTER_ID_OFFSET - index,
      label: r.displayName,
      skill: r.skill,
      isLive: false,
      statusText: '',
    };
  });

  staff.sort(byId);
  helpWanted.sort(byId);
  openItems.sort(byId);

  return { staff, helpWanted, openItems, roster: rosterEntries };
}
