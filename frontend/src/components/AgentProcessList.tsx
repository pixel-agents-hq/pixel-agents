import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { CARD_SUBAGENT_TOOLS_COLLAPSED } from '../constants';
import { backgroundTools, subagentLabel } from '../features/agents/agentSelectors';
import type { AgentRunState } from '../features/agents/agentSelectors';
import type { Agent, SubagentActivity } from '../features/agents/agentsSlice';
import { MonoText } from './MonoText';
import { StatusDot } from './StatusDot';

function subagentState(subagent: SubagentActivity): AgentRunState {
  if (subagent.permissionPending) return 'waiting';
  return subagent.tools.some((tool) => !tool.done) ? 'running' : 'idle';
}

function SubagentRow({
  agent,
  subagent,
  expanded,
}: {
  agent: Agent;
  subagent: SubagentActivity;
  expanded: boolean;
}) {
  const shownTools = expanded
    ? subagent.tools
    : subagent.tools.slice(-CARD_SUBAGENT_TOOLS_COLLAPSED);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <StatusDot state={subagentState(subagent)} size={6} />
        <Typography noWrap sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>
          {subagentLabel(agent, subagent)}
        </Typography>
        <Box sx={{ ml: 'auto', flexShrink: 0 }}>
          <MonoText>{subagent.tools.length} 筆</MonoText>
        </Box>
      </Box>
      <Box sx={{ pl: '14px', display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {shownTools.map((tool) => (
          <Box
            key={tool.toolId}
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              opacity: tool.done ? 0.6 : 1,
            }}
          >
            <MonoText color={tool.done ? 'text.disabled' : 'text.secondary'}>
              {tool.status}
            </MonoText>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** 卡片上的子代理與背景工具：預設只露出最近一筆，展開後看到最近幾筆工具活動。 */
export function AgentProcessList({ agent }: { agent: Agent }) {
  const [expanded, setExpanded] = useState(false);
  const background = backgroundTools(agent);
  if (agent.subagents.length === 0 && background.length === 0) return null;

  const canExpand = agent.subagents.some(
    (subagent) => subagent.tools.length > CARD_SUBAGENT_TOOLS_COLLAPSED,
  );

  return (
    <Box
      sx={{
        position: 'relative',
        zIndex: 1,
        p: '10px 16px',
        borderTop: 1,
        borderColor: 'rgba(26,26,36,1)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Typography sx={{ fontSize: 10, color: 'text.disabled', letterSpacing: '0.04em' }}>
          子代理 {agent.subagents.length} · 背景 {background.length}
        </Typography>
        {canExpand && (
          <ButtonBase
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            sx={{ ml: 'auto', fontSize: 10, color: 'primary.light', px: 0.5 }}
          >
            {expanded ? '收合' : '展開 log'}
          </ButtonBase>
        )}
      </Box>
      {agent.subagents.map((subagent) => (
        <SubagentRow
          key={subagent.parentToolId}
          agent={agent}
          subagent={subagent}
          expanded={expanded}
        />
      ))}
      {background.map((tool) => (
        <Box
          key={tool.toolId}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}
        >
          <StatusDot state="running" size={6} />
          <MonoText color="text.secondary">{tool.toolName ?? 'tool'}</MonoText>
          <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <MonoText>{tool.status}</MonoText>
          </Box>
          <Box sx={{ ml: 'auto', flexShrink: 0 }}>
            <MonoText>背景</MonoText>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
