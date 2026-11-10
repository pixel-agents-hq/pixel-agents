import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useSearchParams } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { Logo } from '../components/Logo';
import { selectAllAgents } from '../features/agents/agentSelectors';

const SIDEBAR_WIDTH_PX = 220;

const sectionLabelSx = {
  fontSize: 10,
  color: 'text.disabled',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} as const;

const itemSx = {
  display: 'block',
  mx: 1,
  my: '1px',
  px: '11px',
  py: '6px',
  borderRadius: '4px',
  textDecoration: 'none',
} as const;

interface ManagementSidebarProps {
  /** 表單進行中時，在清單尾端顯示的虛線佔位項目；不是表單頁就不傳 */
  placeholder?: string;
}

/** 新增工作空間、新增 Agent 這類表單頁用的側欄：列出所有工作空間，不綁定單一工作空間。 */
export function ManagementSidebar({ placeholder }: ManagementSidebarProps) {
  const [searchParams] = useSearchParams();
  const selectedWorkspaceId = searchParams.get('workspace');
  const workspaces = useAppSelector((state) => state.workspaces.workspaces);
  const agents = useAppSelector(selectAllAgents);
  const connected = useAppSelector((state) => state.connection.status === 'connected');

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
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>passon-agents</Typography>
        <Box
          role="img"
          aria-label={connected ? '已連線' : '未連線'}
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: connected ? 'success.main' : 'warning.main',
            boxShadow: connected ? '0 0 6px #22c55e' : 'none',
          }}
        />
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 0.5, mb: '2px' }}>
          <Typography sx={{ ...sectionLabelSx, flex: 1 }}>Workspaces</Typography>
          <Box
            component={RouterLink}
            to="/workspaces/new"
            aria-label="新增工作空間"
            sx={{
              width: 18,
              height: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'primary.light',
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            +
          </Box>
        </Box>

        {workspaces.map((workspace) => {
          const count = agents.filter((agent) => agent.workspaceId === workspace.id).length;
          const selected = workspace.id === selectedWorkspaceId;
          return (
            <Box
              key={workspace.id}
              component={RouterLink}
              to={`/w/${workspace.id}`}
              sx={{
                ...itemSx,
                ...(selected && {
                  bgcolor: 'rgba(91,48,214,0.1)',
                  borderLeft: '2px solid',
                  borderLeftColor: 'primary.main',
                }),
              }}
            >
              <Typography
                sx={{ fontSize: 13, color: selected ? 'text.primary' : 'text.secondary' }}
              >
                {workspace.name}
              </Typography>
              <Typography
                sx={{
                  fontSize: 11,
                  color: selected ? 'text.disabled' : 'text.disabled',
                  mt: '1px',
                }}
              >
                {count} {count === 1 ? 'agent' : 'agents'}
              </Typography>
            </Box>
          );
        })}

        {placeholder && (
          <Box
            sx={{
              mx: 1,
              my: '1px',
              px: 1,
              py: '6px',
              borderRadius: '4px',
              bgcolor: 'rgba(91,48,214,0.08)',
              border: '1px dashed rgba(91,48,214,0.3)',
            }}
          >
            <Typography sx={{ fontSize: 13, color: 'primary.main', fontStyle: 'italic' }}>
              {placeholder}
            </Typography>
          </Box>
        )}

        <Box sx={{ borderTop: 1, borderColor: 'divider', my: 1 }} />
        <Box component={RouterLink} to="/agents" sx={itemSx}>
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>All Agents</Typography>
        </Box>
      </Box>

      <Box sx={{ px: 2, py: 1.25, borderTop: 1, borderColor: 'divider' }}>
        <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
          {agents.length} agents total
        </Typography>
      </Box>
    </Box>
  );
}
