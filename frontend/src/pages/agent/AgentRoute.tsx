import { Navigate, Outlet, useLocation, useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { selectAgent } from '../../features/agents/agentSelectors';
import { NotFoundPage } from '../NotFoundPage';

/** 以網址上的 agentId 取出 Agent；不存在顯示提示，工作空間對不上就轉址到正確的位置。 */
export function AgentRoute() {
  const { workspaceId = '', agentId = '' } = useParams();
  const location = useLocation();
  const agent = useAppSelector((state) => selectAgent(state, Number(agentId)));

  if (!agent) {
    return <NotFoundPage message={`找不到 Agent ${agentId}`} homeTo={`/w/${workspaceId}`} />;
  }
  if (agent.workspaceId !== workspaceId) {
    const pathname = location.pathname.replace(`/w/${workspaceId}/`, `/w/${agent.workspaceId}/`);
    return <Navigate to={{ pathname, search: location.search }} replace />;
  }
  return <Outlet />;
}
