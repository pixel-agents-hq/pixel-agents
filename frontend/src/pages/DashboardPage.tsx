import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useParams } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { AgentCard } from '../components/AgentCard';
import {
  agentDisplayName,
  deriveRunState,
  selectAgentsInWorkspace,
} from '../features/agents/agentSelectors';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';

export function DashboardPage() {
  const { workspaceId = '' } = useParams();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspaceId));
  const curatorId = useAppSelector((state) => state.workspaces.curators[workspaceId]);
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const readOnly = useAppSelector((state) => state.connection.readOnly);

  const running = agents.filter((agent) => deriveRunState(agent) === 'running').length;
  const idle = agents.filter((agent) => deriveRunState(agent) === 'idle').length;
  const curator = agents.find((agent) => agent.id === curatorId);

  return (
    <>
      <Box
        sx={{
          px: 3,
          pt: 2.5,
          pb: 2,
          display: 'flex',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box>
          <Typography variant="h6">{workspace?.name}</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.disabled', mt: '1px' }}>
            {agents.length} agents · {running} running · {idle} idle
            {curator && (
              <Box component="span" sx={{ color: 'success.main' }}>
                {' · '}KB Writer: {agentDisplayName(curator)}
              </Box>
            )}
          </Typography>
        </Box>
        <Box sx={{ ml: 'auto', display: 'flex', gap: 1, alignItems: 'center' }}>
          {curatorsAvailable && (
            <Button variant="outlined" component={RouterLink} to={`/w/${workspaceId}/kb-review`}>
              KB Review
            </Button>
          )}
          <Button
            variant="contained"
            component={RouterLink}
            to={`/agents/new?workspace=${workspaceId}`}
            disabled={readOnly}
          >
            + Agent
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          p: 3,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 1.5,
          alignContent: 'start',
        }}
      >
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} workspaceId={workspaceId} />
        ))}
        {!readOnly && (
          <Box
            component={RouterLink}
            to={`/agents/new?workspace=${workspaceId}`}
            sx={{
              minHeight: 160,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              bgcolor: 'background.default',
              border: '1px dashed',
              borderColor: 'divider',
              borderRadius: '6px',
              textDecoration: 'none',
              color: 'text.disabled',
              fontSize: 12,
            }}
          >
            <Box sx={{ fontSize: 20, fontWeight: 300, lineHeight: 1 }}>+</Box>
            新增 Agent 到 {workspace?.name}
          </Box>
        )}
      </Box>
    </>
  );
}
