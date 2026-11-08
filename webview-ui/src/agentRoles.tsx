// webview-ui/src/agentRoles.tsx
//
// Which Role each agent was launched with, for the agent card and its tooltip.
// Only the display name ever reaches the webview (agentCreated.roleName,
// existingAgents.roleNames) -- never the Role's content or hash.

import { createContext, useContext } from 'react';

export type AgentRoleNames = Record<number, string>;

/** Add (or leave alone) the Role an agentCreated message carried. */
export function withAgentRoleName(
  names: AgentRoleNames,
  id: number,
  roleName: string | undefined,
): AgentRoleNames {
  if (typeof roleName !== 'string' || roleName === '') return names;
  return names[id] === roleName ? names : { ...names, [id]: roleName };
}

/** Merge the existingAgents `roleNames` map (string-keyed on the wire). */
export function mergeAgentRoleNames(
  names: AgentRoleNames,
  incoming: Record<string, string> | undefined,
): AgentRoleNames {
  if (!incoming) return names;
  const merged = { ...names };
  for (const [key, roleName] of Object.entries(incoming)) {
    const id = Number(key);
    if (Number.isInteger(id) && typeof roleName === 'string' && roleName !== '') {
      merged[id] = roleName;
    }
  }
  return merged;
}

const AgentRoleNamesContext = createContext<AgentRoleNames>({});

export const AgentRoleNamesProvider = AgentRoleNamesContext.Provider;

/** The Role name of an agent, or undefined when it has none. */
export function useAgentRoleName(agentId: number): string | undefined {
  return useContext(AgentRoleNamesContext)[agentId];
}

/** Tooltip text for an agent card. */
export function agentCardTitle(agentId: number, roleName: string | undefined): string {
  return roleName ? `Agent ${agentId} - Role: ${roleName}` : `Agent ${agentId}`;
}

/** Every agent's Role name, for a surface that renders many agents. */
export function useAgentRoleNames(): AgentRoleNames {
  return useContext(AgentRoleNamesContext);
}
