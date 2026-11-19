/**
 * How the Pixel Office MCP names an agent to people and to other agents: the
 * tag a Message arrives with (`[From <label>, agent <id>] <text>`, so its
 * recipient knows whom to answer; keys go bare, a tag would type into the
 * prompt they answer) and the layout editor's "Undo <label>'s edit".
 */

import { agentLabelOf } from '../../../core/src/agentLabel.js';
import { getCharacterProfiles } from '../characterProfilesStore.js';
import type { AgentState } from '../types.js';

/** An agent's label: its Nickname, else the name of the character it wears,
 *  else its Directory; null when it has none of them. */
export function agentLabel(
  agent: Pick<AgentState, 'nickname' | 'palette' | 'directoryName'>,
): string | null {
  const character = agent.palette === undefined ? undefined : getCharacterProfiles()[agent.palette];
  return agentLabelOf({
    nickname: agent.nickname,
    characterName: character?.name,
    directoryName: agent.directoryName,
  });
}

/** The tag a Message's text is prefixed with. */
export function messageTag(agentId: number, from: string | null): string {
  return from ? `[From ${from}, agent ${agentId}] ` : `[From agent ${agentId}] `;
}
