import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { useAppSelector } from '../../app/hooks';
import { GuardStatusPanel } from '../../components/GuardStatusPanel';
import { RoleBadge } from '../../components/RoleBadge';
import { agentDisplayName } from '../../features/agents/agentSelectors';
import { buildGuardStatus } from '../../features/agents/guardStatus';
import { selectWorkspace } from '../../features/workspaces/workspaceSelectors';
import { useRouteAgent } from './useRouteAgent';

export function RoleActivityTab() {
  const agent = useRouteAgent();
  const { guard } = agent;
  const rootPath = useAppSelector((state) => selectWorkspace(state, agent.workspaceId)?.rootPath);
  const curatorName = useAppSelector((state) => {
    const curatorId = state.workspaces.curators[agent.workspaceId];
    if (curatorId === undefined) return null;
    const curator = state.agents.byId[curatorId];
    return curator ? agentDisplayName(curator) : `agent-${curatorId}`;
  });

  if (!guard) {
    return (
      <Typography sx={{ p: 3, fontSize: 12, color: 'text.disabled' }}>
        尚未收到這個 Agent 的規則生效狀態
      </Typography>
    );
  }

  const status = buildGuardStatus(guard, rootPath, curatorName);

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 560 }}>
      <Box>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
          啟動時的 roles
        </Typography>
        {guard.permissionRoles === null ? (
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            無（不套用權限限制）
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', gap: 0.75 }}>
            {guard.permissionRoles.map((role) => (
              <RoleBadge key={role} role={role} />
            ))}
          </Box>
        )}
      </Box>
      <Box>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
          規則是否生效
        </Typography>
        <GuardStatusPanel status={status} />
      </Box>
    </Box>
  );
}
