import { useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { selectAgent } from '../../features/agents/agentSelectors';
import type { Agent } from '../../features/agents/agentsSlice';

/** 只能在 AgentRoute 底下使用：該層已保證 Agent 存在。 */
export function useRouteAgent(): Agent {
  const { agentId = '' } = useParams();
  const agent = useAppSelector((state) => selectAgent(state, Number(agentId)));
  if (!agent) throw new Error(`Agent ${agentId} 不存在`);
  return agent;
}
