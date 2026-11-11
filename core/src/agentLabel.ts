/**
 * How an agent is named to people: its Nickname, else the name of the character
 * it wears, else its Directory; null when it has none of them. The ONE rule, for
 * the server (the Pixel Office MCP's Message tag and "Undo <agent>'s edit") and
 * the office (a Furniture label's "who works here") alike; each side supplies the
 * character's name from its own copy of the cast.
 *
 * Pure: no store, no DOM.
 */
export function agentLabelOf(agent: {
  nickname?: string | null;
  characterName?: string | null;
  directoryName?: string | null;
}): string | null {
  return agent.nickname || agent.characterName || agent.directoryName || null;
}
