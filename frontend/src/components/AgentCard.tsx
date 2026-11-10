import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  RUN_STATE_LABELS,
  activeTools,
  agentDisplayName,
  deriveRunState,
} from '../features/agents/agentSelectors';
import type { Agent } from '../features/agents/agentsSlice';
import { clientMessageRequested } from '../features/connection/actions';
import { statusColors } from '../theme';
import { AgentRoleBadges } from './AgentRoleBadges';
import { Elapsed } from './Elapsed';
import { MonoText } from './MonoText';
import { StartAgentButton } from './StartAgentButton';
import { StatusDot } from './StatusDot';

const TOOLS_SHOWN = 2;

export function AgentCard({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const dispatch = useAppDispatch();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const isCurator = useAppSelector((state) => state.workspaces.curators[workspaceId] === agent.id);
  const directoryPath = useAppSelector(
    (state) => state.workspaces.directories.find((d) => d.name === agent.directoryName)?.path,
  );
  const readOnly = useAppSelector((state) => state.connection.readOnly);
  const terminalAvailable = useAppSelector((state) => state.connection.terminalAvailable);
  const runState = deriveRunState(agent);
  const { color } = statusColors[runState];
  const tools = activeTools(agent).slice(-TOOLS_SHOWN);

  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: '6px',
        overflow: 'hidden',
        position: 'relative',
        '&:hover': { borderColor: 'rgba(167,139,250,0.6)' },
      }}
    >
      <Box
        component={RouterLink}
        to={`/w/${workspaceId}/agents/${agent.id}`}
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          p: '14px 16px 12px',
          borderBottom: 1,
          borderColor: 'rgba(26,26,36,1)',
          textDecoration: 'none',
          color: 'inherit',
          // 讓連結涵蓋整張卡片，點卡片任何位置都開啟 Agent 詳情頁；Terminal 按鈕才開執行區塊
          '&::after': { content: '""', position: 'absolute', inset: 0 },
        }}
      >
        <Box sx={{ mt: '4px' }}>
          <StatusDot state={runState} size={8} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <Typography
              noWrap
              sx={{
                fontSize: 14,
                fontWeight: 600,
                color: runState === 'idle' ? 'text.secondary' : 'text.primary',
              }}
            >
              {agentDisplayName(agent)}
            </Typography>
            <AgentRoleBadges agent={agent} isCurator={isCurator} />
          </Box>
          {directoryPath && (
            <Box sx={{ mt: '2px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <MonoText>{directoryPath}</MonoText>
            </Box>
          )}
        </Box>
        <Box
          sx={{
            fontSize: 11,
            color,
            px: 1,
            py: '2px',
            borderRadius: '3px',
            border: `1px solid ${color}33`,
            bgcolor: `${color}14`,
            flexShrink: 0,
          }}
        >
          {RUN_STATE_LABELS[runState]}
        </Box>
      </Box>

      <Box
        sx={{
          p: '12px 16px',
          bgcolor: 'background.default',
          minHeight: 64,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          justifyContent: 'center',
        }}
      >
        {tools.length === 0 ? (
          <Typography sx={{ fontSize: 11, color: 'text.disabled', textAlign: 'center' }}>
            {runState === 'stopped' ? '尚未啟用，按「啟用」開始' : '無進行中的工具呼叫'}
          </Typography>
        ) : (
          tools.map((tool) => (
            <Box key={tool.toolId} sx={{ display: 'flex', gap: 1, minWidth: 0 }}>
              <MonoText color="text.secondary">{tool.toolName ?? 'tool'}</MonoText>
              <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <MonoText>{tool.status}</MonoText>
              </Box>
            </Box>
          ))
        )}
      </Box>

      <Box
        sx={{
          position: 'relative',
          zIndex: 1,
          p: '10px 16px',
          borderTop: 1,
          borderColor: 'rgba(26,26,36,1)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
          {runState === 'running' ? <Elapsed since={agent.startedAt} /> : '—'}
        </Typography>
        <Box sx={{ ml: 'auto', display: 'flex', gap: '6px' }}>
          {runState === 'stopped' ? (
            <StartAgentButton agentId={agent.id} />
          ) : (
            <Button
              size="small"
              variant="outlined"
              component={RouterLink}
              to={`/w/${workspaceId}/agents/${agent.id}/terminal`}
              disabled={!terminalAvailable}
              sx={{ fontSize: 11, py: '4px', px: '10px' }}
            >
              Terminal
            </Button>
          )}
          <Button
            size="small"
            variant="outlined"
            aria-label="更多動作"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            sx={{ fontSize: 11, py: '4px', px: 1, minWidth: 0 }}
          >
            ···
          </Button>
          <Menu
            anchorEl={menuAnchor}
            open={menuAnchor !== null}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem
              disabled={readOnly}
              onClick={() => {
                setMenuAnchor(null);
                dispatch(clientMessageRequested({ type: 'closeAgent', id: agent.id }));
              }}
              sx={{ fontSize: 12, color: 'error.main' }}
            >
              刪除 Agent
            </MenuItem>
          </Menu>
        </Box>
      </Box>
    </Box>
  );
}
