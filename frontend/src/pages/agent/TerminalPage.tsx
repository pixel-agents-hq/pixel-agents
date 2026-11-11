import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { MonoText } from '../../components/MonoText';
import { StatusDot } from '../../components/StatusDot';
import { agentDisplayName, deriveRunState } from '../../features/agents/agentSelectors';
import { AgentTerminal } from './AgentTerminal';
import { useRouteAgent } from './useRouteAgent';

export function TerminalPage() {
  const { workspaceId = '' } = useParams();
  const agent = useRouteAgent();
  const directoryPath = useAppSelector(
    (state) => state.workspaces.directories.find((d) => d.name === agent.directoryName)?.path,
  );
  return (
    <>
      <Box
        sx={{
          height: 40,
          px: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <StatusDot state={deriveRunState(agent)} />
        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{agentDisplayName(agent)}</Typography>
        {directoryPath && <MonoText>{directoryPath}</MonoText>}
        <Box sx={{ ml: 'auto' }}>
          <Button
            size="small"
            variant="outlined"
            component={RouterLink}
            to={`/w/${workspaceId}/agents/${agent.id}/log`}
            sx={{ fontSize: 11 }}
          >
            Session Log
          </Button>
        </Box>
      </Box>

      <AgentTerminal agent={agent} />
    </>
  );
}
