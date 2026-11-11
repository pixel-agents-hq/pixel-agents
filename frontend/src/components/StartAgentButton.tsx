import Button from '@mui/material/Button';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { clientMessageRequested } from '../features/connection/actions';

interface StartAgentButtonProps {
  agentId: number;
  size?: 'small' | 'medium';
}

/** 為還沒有程序的 Agent 啟動 Claude Code（有對話紀錄就接續）。 */
export function StartAgentButton({ agentId, size = 'small' }: StartAgentButtonProps) {
  const dispatch = useAppDispatch();
  const terminalAvailable = useAppSelector((state) => state.connection.terminalAvailable);
  return (
    <Button
      size={size}
      variant="contained"
      disabled={!terminalAvailable}
      onClick={() => dispatch(clientMessageRequested({ type: 'startAgent', id: agentId }))}
      sx={{ fontSize: 11, py: '4px', px: '14px' }}
    >
      啟用
    </Button>
  );
}
