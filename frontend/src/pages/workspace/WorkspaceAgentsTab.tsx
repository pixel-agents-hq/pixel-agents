import Box from '@mui/material/Box';
import { useState } from 'react';
import { useParams } from 'react-router';

import { useAppSelector } from '../../app/hooks';
import { ActivateAgentDialog } from '../../components/ActivateAgentDialog';
import { AgentCard } from '../../components/AgentCard';
import { selectAgentsInWorkspace } from '../../features/agents/agentSelectors';
import { selectWorkspace } from '../../features/workspaces/workspaceSelectors';

export function WorkspaceAgentsTab() {
  const { workspaceId = '' } = useParams();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspaceId));
  const [activating, setActivating] = useState(false);

  return (
    <>
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          p: 3,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 1.5,
          alignContent: 'start',
        }}
      >
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} workspaceId={workspaceId} />
        ))}
        <Box
          component="button"
          type="button"
          onClick={() => setActivating(true)}
          sx={{
            font: 'inherit',
            cursor: 'pointer',
            minHeight: 160,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            bgcolor: 'background.default',
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: '6px',
            textDecoration: 'none',
            color: 'text.disabled',
            fontSize: 12,
          }}
        >
          <Box sx={{ fontSize: 20, fontWeight: 300, lineHeight: 1 }}>+</Box>
          新增 Agent 到 {workspace?.name}
        </Box>
      </Box>
      <ActivateAgentDialog
        workspaceId={workspaceId}
        workspaceName={workspace?.name ?? ''}
        open={activating}
        onClose={() => setActivating(false)}
      />
    </>
  );
}
