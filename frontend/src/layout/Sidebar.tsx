import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useMatch, useNavigate } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { AgentRoleBadges } from '../components/AgentRoleBadges';
import { Elapsed } from '../components/Elapsed';
import { Logo } from '../components/Logo';
import { MonoText } from '../components/MonoText';
import { RoleBadge } from '../components/RoleBadge';
import { StatusDot } from '../components/StatusDot';
import {
  RUN_STATE_LABELS,
  agentDisplayName,
  deriveRunState,
  selectAgentsInWorkspace,
} from '../features/agents/agentSelectors';
import type { Agent } from '../features/agents/agentsSlice';
import { controlBorderColor, statusColors } from '../theme';
import { selectVisibleWorkspaces } from '../features/workspaces/workspaceSelectors';

const SIDEBAR_WIDTH_PX = 240;
const CONNECTION_LABELS = { connecting: '連線中', connected: '已連線', reconnecting: '重新連線中' };

const sectionLabelSx = {
  fontSize: 10,
  color: 'text.disabled',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} as const;

function AgentItem({
  agent,
  workspaceId,
  selected,
}: {
  agent: Agent;
  workspaceId: string;
  selected: boolean;
}) {
  const isCurator = useAppSelector((state) => state.workspaces.curators[workspaceId] === agent.id);
  const runState = deriveRunState(agent);
  const detail =
    runState === 'running' ? (
      <>
        running · <Elapsed since={agent.startedAt} />
      </>
    ) : (
      <>
        {RUN_STATE_LABELS[runState]}
        {isCurator && ' · KB Writer'}
      </>
    );
  return (
    <Box
      component={RouterLink}
      to={`/w/${workspaceId}/agents/${agent.id}`}
      sx={{
        display: 'block',
        p: '8px',
        mb: '3px',
        borderRadius: '4px',
        textDecoration: 'none',
        border: '1px solid transparent',
        borderLeft: '3px solid transparent',
        ...(selected && {
          bgcolor: 'rgba(109,63,232,0.2)',
          borderColor: 'rgba(167,139,250,0.4)',
          borderLeftColor: 'primary.light',
        }),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <StatusDot state={runState} />
        <Typography
          noWrap
          sx={{
            flex: 1,
            fontSize: 12,
            color: selected ? 'text.primary' : 'text.secondary',
            fontWeight: selected ? 600 : 400,
          }}
        >
          {agentDisplayName(agent)}
        </Typography>
        <AgentRoleBadges agent={agent} isCurator={isCurator} />
      </Box>
      <Box sx={{ mt: '3px', pl: '14px' }}>
        <MonoText color={selected ? 'primary.light' : statusColors[runState].color}>
          {detail}
        </MonoText>
      </Box>
    </Box>
  );
}

export function Sidebar({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const agentMatch = useMatch('/w/:workspaceId/agents/:agentId/*');
  const selectedAgentId = agentMatch?.params.agentId;
  const workspaces = useAppSelector(selectVisibleWorkspaces);
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspaceId));
  const curatorsAvailable = useAppSelector((state) => state.workspaces.curatorsAvailable);
  const connectionStatus = useAppSelector((state) => state.connection.status);

  return (
    <Box
      component="nav"
      sx={{
        width: SIDEBAR_WIDTH_PX,
        flexShrink: 0,
        bgcolor: 'background.paper',
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          height: 48,
          px: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Logo />
        <Typography sx={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.02em' }}>
          passon agents
        </Typography>
      </Box>

      <Box sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography sx={{ ...sectionLabelSx, mb: '6px' }}>工作空間</Typography>
        <Select
          fullWidth
          size="small"
          value={workspaceId}
          onChange={(event) => void navigate(`/w/${event.target.value}`)}
          sx={{
            fontSize: 13,
            bgcolor: 'background.default',
            '& fieldset': { borderColor: controlBorderColor },
          }}
        >
          {workspaces.map((workspace) => (
            <MenuItem key={workspace.id} value={workspace.id} sx={{ fontSize: 13 }}>
              {workspace.name}
            </MenuItem>
          ))}
        </Select>
        <Button
          fullWidth
          variant="outlined"
          component={RouterLink}
          to="/workspaces/new"
          sx={{
            justifyContent: 'flex-start',
            borderStyle: 'dashed',
            color: 'text.disabled',
            mt: 0.75,
          }}
        >
          + 新增工作空間
        </Button>
      </Box>

      <Typography sx={{ ...sectionLabelSx, px: 1.5, pt: 0.5, pb: '6px' }}>
        Agents · {agents.length}
      </Typography>
      <Box sx={{ flex: 1, overflowY: 'auto', px: 1 }}>
        {agents.map((agent) => (
          <AgentItem
            key={agent.id}
            agent={agent}
            workspaceId={workspaceId}
            selected={selectedAgentId === String(agent.id)}
          />
        ))}
      </Box>

      {curatorsAvailable && (
        <Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider' }}>
          <Button
            fullWidth
            component={RouterLink}
            to={`/w/${workspaceId}/kb-review`}
            sx={{
              justifyContent: 'flex-start',
              color: 'success.main',
              bgcolor: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            KB Review
          </Button>
        </Box>
      )}

      <Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider' }}>
        <Typography sx={{ ...sectionLabelSx, mb: '5px' }}>Roles</Typography>
        <Box sx={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          <RoleBadge role="R" label="讀取" />
          <RoleBadge role="E" label="編輯" />
          <RoleBadge role="D" label="刪除" />
          <RoleBadge role="W" label="KB寫入" />
        </Box>
      </Box>

      <Box sx={{ px: 1.5, py: 1.25, borderTop: 1, borderColor: 'divider' }}>
        <MonoText>{CONNECTION_LABELS[connectionStatus]}</MonoText>
      </Box>
    </Box>
  );
}
