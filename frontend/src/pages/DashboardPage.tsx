import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, Outlet, useLocation, useParams } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { KbWriterVacancy } from '../components/KbWriterVacancy';
import { KB_TAB_LABEL, WORKSPACE_SETTINGS_TEXT } from '../constants';
import {
  agentDisplayName,
  deriveRunState,
  selectAgentsInWorkspace,
} from '../features/agents/agentSelectors';
import { DEFAULT_WORKSPACE_ID } from '../protocol';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';

const TABS = [
  { value: 'agents', suffix: '', label: 'Agents' },
  { value: 'kb', suffix: '/kb', label: KB_TAB_LABEL },
];

export function DashboardPage() {
  const { workspaceId = '' } = useParams();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspaceId));
  const curatorId = useAppSelector((state) => state.workspaces.curators[workspaceId]);
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const location = useLocation();
  const currentTab = location.pathname.endsWith('/kb') ? 'kb' : 'agents';

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
          {workspaceId !== DEFAULT_WORKSPACE_ID && (
            <Button variant="outlined" component={RouterLink} to={`/w/${workspaceId}/settings`}>
              {WORKSPACE_SETTINGS_TEXT.open}
            </Button>
          )}
          {curatorsAvailable && (
            <Button variant="outlined" component={RouterLink} to={`/w/${workspaceId}/kb-review`}>
              KB Review
            </Button>
          )}
          <Button
            variant="contained"
            component={RouterLink}
            to={`/agents/new?workspace=${workspaceId}`}
          >
            + Agent
          </Button>
        </Box>
      </Box>

      <KbWriterVacancy
        workspaceId={workspaceId}
        sx={{ px: 3, py: 1, borderBottom: 1, borderColor: 'divider' }}
      />

      <Tabs
        value={currentTab}
        sx={{
          minHeight: 36,
          px: 3,
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => (
          <Tab
            key={tab.value}
            value={tab.value}
            label={tab.label}
            component={RouterLink}
            to={`/w/${workspaceId}${tab.suffix}`}
            sx={{ minHeight: 36, py: 0, fontSize: 12 }}
          />
        ))}
      </Tabs>

      <Box
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <Outlet />
      </Box>
    </>
  );
}
