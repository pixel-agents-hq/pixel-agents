import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { useAppSelector } from '../../app/hooks';
import { MonoText } from '../../components/MonoText';
import { serverToken } from '../connection/serverToken';
import type { TerminalStatus } from './terminalConnection';
import { TerminalView } from './TerminalView';

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: '連線中',
  connected: '已連線',
  reconnecting: '重新連線中',
  closed: '已中斷',
};

/** 一個 Agent 的 Claude Code 執行區塊：可以看到完整輸出，也可以直接輸入與它對話。 */
export function TerminalPanel({ agentId }: { agentId: number }) {
  const terminalAvailable = useAppSelector((state) => state.connection.terminalAvailable);
  const unavailableReason = useAppSelector((state) => state.connection.terminalUnavailableReason);
  const [status, setStatus] = useState<TerminalStatus>('connecting');

  const blocker = !terminalAvailable
    ? (unavailableReason ?? '這個主機沒有提供終端機')
    : serverToken === null
      ? '本頁沒有 token，無法連線終端機；請用 CLI 印出的網址開啟'
      : null;

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {blocker ? (
        <Typography sx={{ flex: 1, p: 3, fontSize: 12, color: 'text.disabled' }}>
          {blocker}
        </Typography>
      ) : (
        <TerminalView agentId={agentId} onStatusChange={setStatus} />
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
        <MonoText color={!blocker && status === 'connected' ? 'success.main' : 'text.disabled'}>
          {blocker ? '無法使用' : STATUS_LABELS[status]}
        </MonoText>
      </Box>
    </Box>
  );
}
