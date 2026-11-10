import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { MonoText } from '../../components/MonoText';
import { StatusDot } from '../../components/StatusDot';
import { agentDisplayName, deriveRunState } from '../../features/agents/agentSelectors';
import { serverToken } from '../../features/connection/serverToken';
import { TerminalView } from '../../features/terminal/TerminalView';
import type { TerminalStatus } from '../../features/terminal/terminalConnection';
import { useRouteAgent } from './useRouteAgent';

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: '連線中',
  connected: '已連線',
  reconnecting: '重新連線中',
  closed: '已中斷',
};

export function TerminalPage() {
  const { workspaceId = '' } = useParams();
  const agent = useRouteAgent();
  const terminalAvailable = useAppSelector((state) => state.connection.terminalAvailable);
  const unavailableReason = useAppSelector((state) => state.connection.terminalUnavailableReason);
  const directoryPath = useAppSelector(
    (state) => state.workspaces.directories.find((d) => d.name === agent.directoryName)?.path,
  );
  const [status, setStatus] = useState<TerminalStatus>('connecting');

  const blocker = !terminalAvailable
    ? (unavailableReason ?? '這個主機沒有提供終端機')
    : serverToken === null
      ? '本頁沒有 token，無法連線終端機；請用 CLI 印出的網址開啟'
      : null;

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

      {blocker ? (
        <Typography sx={{ p: 3, fontSize: 12, color: 'text.disabled' }}>{blocker}</Typography>
      ) : (
        <TerminalView agentId={agent.id} onStatusChange={setStatus} />
      )}

      <Box
        sx={{
          height: 28,
          px: 2,
          display: 'flex',
          alignItems: 'center',
          bgcolor: 'background.paper',
          borderTop: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <MonoText color={status === 'connected' ? 'success.main' : 'text.disabled'}>
          {blocker ? '無法使用' : STATUS_LABELS[status]}
        </MonoText>
      </Box>
    </>
  );
}
