import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { useAppSelector } from '../../app/hooks';
import { MonoText } from '../../components/MonoText';
import { monoFontFamily } from '../../theme';
import { useRouteAgent } from './useRouteAgent';

/** MCP 工具名稱是 mcp__伺服器__工具，只顯示最後的工具名，完整名稱放在 title。 */
function shortToolName(name: string): string {
  return name.split('__').pop() ?? name;
}

export function SessionLogTab() {
  const agent = useRouteAgent();
  const readingTools = useAppSelector((state) => state.connection.readingTools);

  if (agent.tools.length === 0) {
    return (
      <Typography sx={{ p: 3, fontSize: 12, color: 'text.disabled' }}>
        尚未收到這個 Agent 的工具呼叫（只記錄連線之後的活動）
      </Typography>
    );
  }

  return (
    <Box sx={{ p: '16px 20px', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {agent.tools.map((tool) => {
        const isReading = tool.toolName !== undefined && readingTools.includes(tool.toolName);
        return (
          <Box key={tool.toolId} sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline' }}>
            <Box sx={{ width: 88, flexShrink: 0, overflow: 'hidden' }}>
              <Box
                component="span"
                title={tool.toolName}
                sx={{
                  display: 'block',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: monoFontFamily,
                  fontSize: 11,
                  px: '6px',
                  py: '2px',
                  borderRadius: '2px',
                  color: isReading ? 'info.main' : 'text.secondary',
                  bgcolor: isReading ? 'rgba(59,130,246,0.1)' : 'rgba(26,26,36,1)',
                }}
              >
                {tool.toolName ? shortToolName(tool.toolName) : 'tool'}
              </Box>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{
                  fontFamily: monoFontFamily,
                  fontSize: 11,
                  color: tool.done ? 'text.disabled' : 'text.secondary',
                  overflowWrap: 'anywhere',
                }}
              >
                {tool.status}
              </Typography>
            </Box>
            {!tool.done && <MonoText color="primary.main">running</MonoText>}
          </Box>
        );
      })}
    </Box>
  );
}
