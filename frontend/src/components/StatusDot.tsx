import Box from '@mui/material/Box';

import type { AgentRunState } from '../features/agents/agentSelectors';
import { statusColors } from '../theme';

interface StatusDotProps {
  state: AgentRunState;
  size?: number;
}

export function StatusDot({ state, size = 7 }: StatusDotProps) {
  const { color, glow } = statusColors[state];
  return (
    <Box
      component="span"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        bgcolor: color,
        boxShadow: glow,
      }}
    />
  );
}
