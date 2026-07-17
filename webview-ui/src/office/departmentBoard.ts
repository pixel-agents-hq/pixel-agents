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
import type { Character, ToolActivity } from './types.js';

export interface DepartmentBoardEntry {
  id: number;
  label: string;
  statusText: string;
}

export interface DepartmentBoardData {
  staff: DepartmentBoardEntry[];
  helpWanted: DepartmentBoardEntry[];
  openItems: DepartmentBoardEntry[];
}

const byId = (a: DepartmentBoardEntry, b: DepartmentBoardEntry): number => a.id - b.id;

export function deriveDepartmentBoard(
  characters: Map<number, Character>,
  floorId: string,
  agentTools: Record<number, ToolActivity[]>,
): DepartmentBoardData {
  const staff: DepartmentBoardEntry[] = [];
  const helpWanted: DepartmentBoardEntry[] = [];
  const openItems: DepartmentBoardEntry[] = [];

  for (const ch of characters.values()) {
    if (ch.floorId !== floorId || ch.isSubagent) continue;

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

  staff.sort(byId);
  helpWanted.sort(byId);
  openItems.sort(byId);

  return { staff, helpWanted, openItems };
}
