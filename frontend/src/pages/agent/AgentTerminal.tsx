import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { StartAgentButton } from '../../components/StartAgentButton';
import type { Agent } from '../../features/agents/agentsSlice';
import { TerminalPanel } from '../../features/terminal/TerminalPanel';

/** 已啟用的 Agent 顯示 Claude Code 終端機；還沒啟用的先請使用者啟用。 */
export function AgentTerminal({ agent }: { agent: Agent }) {
  if (!agent.stopped) return <TerminalPanel agentId={agent.id} />;
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
      }}
    >
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        這個 Agent 已建立，還沒有啟動 Claude Code
      </Typography>
      <StartAgentButton agentId={agent.id} size="medium" />
    </Box>
  );
}
