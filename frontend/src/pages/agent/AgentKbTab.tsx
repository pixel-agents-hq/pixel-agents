import { useMemo } from 'react';

import { KbPanel } from '../../components/kb/KbPanel';
import type { KbTarget } from '../../protocol';
import { useRouteAgent } from './useRouteAgent';

export function AgentKbTab() {
  const agent = useRouteAgent();
  const target = useMemo<KbTarget>(() => ({ scope: 'agent', agentId: agent.id }), [agent.id]);
  return <KbPanel target={target} />;
}
