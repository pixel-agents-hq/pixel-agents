import type { Agent } from '../features/agents/agentsSlice';
import { RoleBadge } from './RoleBadge';

interface AgentRoleBadgesProps {
  agent: Agent;
  isCurator: boolean;
}

export function AgentRoleBadges({ agent, isCurator }: AgentRoleBadgesProps) {
  const roles = agent.guard?.permissionRoles ?? [];
  return (
    <>
      {roles.map((role) => (
        <RoleBadge key={role} role={role} />
      ))}
      {isCurator && <RoleBadge role="W" />}
    </>
  );
}
