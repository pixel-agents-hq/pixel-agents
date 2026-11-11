import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { AgentCard } from '../components/AgentCard';
import { selectAllAgents } from '../features/agents/agentSelectors';
import { selectVisibleWorkspaces } from '../features/workspaces/workspaceSelectors';

export function AllAgentsPage() {
  const agents = useAppSelector(selectAllAgents);
  const workspaces = useAppSelector(selectVisibleWorkspaces);

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
          <Typography variant="h6">All Agents</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.disabled', mt: '1px' }}>
            {agents.length} agents · {workspaces.length} workspaces
          </Typography>
        </Box>
        <Button variant="contained" component={RouterLink} to="/agents/new" sx={{ ml: 'auto' }}>
          + Agent
        </Button>
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
        {workspaces.map((workspace) => {
          const members = agents.filter((agent) => agent.workspaceId === workspace.id);
          if (members.length === 0) return null;
          return (
            <Box key={workspace.id} sx={{ mb: 3 }}>
              <Typography
                component={RouterLink}
                to={`/w/${workspace.id}`}
                sx={{
                  display: 'inline-block',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'text.secondary',
                  textDecoration: 'none',
                  mb: 1.25,
                }}
              >
                {workspace.name}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                  gap: 1.5,
                }}
              >
                {members.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} workspaceId={workspace.id} />
                ))}
              </Box>
            </Box>
          );
        })}
        {agents.length === 0 && (
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>目前沒有任何 Agent</Typography>
        )}
      </Box>
    </>
  );
}
