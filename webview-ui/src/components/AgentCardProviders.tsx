import type { ReactNode } from 'react';

import type { AgentCuratorsValue } from '../agentCurators.js';
import { AgentCuratorsProvider } from '../agentCurators.js';
import type { AgentRoleNames } from '../agentRoles.js';
import { AgentRoleNamesProvider } from '../agentRoles.js';

/** Both per-agent card contexts (Role names, curators) in one wrapper. */
export function AgentCardProviders({
  roleNames,
  curators,
  children,
}: {
  roleNames: AgentRoleNames;
  curators: AgentCuratorsValue;
  children?: ReactNode;
}) {
  return (
    <AgentRoleNamesProvider value={roleNames}>
      <AgentCuratorsProvider value={curators}>{children}</AgentCuratorsProvider>
    </AgentRoleNamesProvider>
  );
}
