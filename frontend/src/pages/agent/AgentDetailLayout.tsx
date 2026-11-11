import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';

import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { AgentRoleBadges } from '../../components/AgentRoleBadges';
import { Elapsed } from '../../components/Elapsed';
import { KbWriterControl } from '../../components/KbWriterControl';
import { MonoText } from '../../components/MonoText';
import { StartAgentButton } from '../../components/StartAgentButton';
import { StatusDot } from '../../components/StatusDot';
import { agentDisplayName, deriveRunState } from '../../features/agents/agentSelectors';
import { KB_TAB_LABEL } from '../../constants';
import { clientMessageRequested } from '../../features/connection/actions';
import { useRouteAgent } from './useRouteAgent';

const TABS = [
  { path: 'claude', label: 'Claude Code' },
  { path: 'log', label: 'Session Log' },
  { path: 'kb', label: KB_TAB_LABEL },
  { path: 'roles', label: 'Role Activity' },
];

export function AgentDetailLayout() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId = '' } = useParams();
  const agent = useRouteAgent();
  const isCurator = useAppSelector((state) => state.workspaces.curators[workspaceId] === agent.id);
  const directoryPath = useAppSelector(
    (state) => state.workspaces.directories.find((d) => d.name === agent.directoryName)?.path,
  );
  const runState = deriveRunState(agent);
  const currentTab =
    TABS.find((tab) => location.pathname.endsWith(`/${tab.path}`))?.path ?? 'claude';
  const basePath = `/w/${workspaceId}/agents/${agent.id}`;

  const remove = () => {
    dispatch(clientMessageRequested({ type: 'closeAgent', id: agent.id }));
    void navigate(`/w/${workspaceId}`);
  };

  return (
    <>
      <Box
        sx={{
          height: 40,
          px: 2.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <StatusDot state={runState} />
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{agentDisplayName(agent)}</Typography>
        {directoryPath && <MonoText>{directoryPath}</MonoText>}
        <AgentRoleBadges agent={agent} isCurator={isCurator} />
        <Box sx={{ ml: 'auto', display: 'flex', gap: 0.75, alignItems: 'center' }}>
          <KbWriterControl agent={agent} />
          {runState === 'stopped' && <StartAgentButton agentId={agent.id} />}
          <Button
            size="small"
            variant="outlined"
            color="error"
            onClick={remove}
            sx={{ fontSize: 11 }}
          >
            刪除
          </Button>
        </Box>
      </Box>

      <Tabs
        value={currentTab}
        sx={{
          minHeight: 36,
          px: 2.5,
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => (
          <Tab
            key={tab.path}
            value={tab.path}
            label={tab.label}
            component={RouterLink}
            to={`${basePath}/${tab.path}`}
            sx={{ minHeight: 36, py: 0, fontSize: 12 }}
          />
        ))}
      </Tabs>

      <Box
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <Outlet />
      </Box>

      <Box
        sx={{
          height: 28,
          px: 2.5,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          bgcolor: '#0a0a0f',
          borderTop: 1,
          borderColor: 'rgba(26,26,36,1)',
          flexShrink: 0,
        }}
      >
        {runState === 'running' && (
          <MonoText>
            <Elapsed since={agent.startedAt} />
          </MonoText>
        )}
        <MonoText>{agent.tools.length} tool calls</MonoText>
        {agent.contextTokens !== null && agent.maxContextTokens !== null && (
          <MonoText>
            context {Math.round((agent.contextTokens / agent.maxContextTokens) * 100)}%
          </MonoText>
        )}
        {agent.guard && (
          <MonoText color={agent.guard.active ? 'success.main' : 'warning.main'}>
            guard: {agent.guard.active ? 'active' : 'inactive'}
          </MonoText>
        )}
      </Box>
    </>
  );
}
