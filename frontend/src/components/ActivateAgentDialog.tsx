import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectAgentsInWorkspace } from '../features/agents/agentSelectors';
import { agentCreationRequested } from '../features/agentCreation/createAgentSaga';
import { directoryForPath, selectWorkspace } from '../features/workspaces/workspaceSelectors';

interface ActivateAgentDialogProps {
  workspaceId: string;
  workspaceName: string;
  open: boolean;
  onClose: () => void;
}

/** 列出工作空間的目錄，點選就在該目錄啟用一個 Agent。 */
export function ActivateAgentDialog({
  workspaceId,
  workspaceName,
  open,
  onClose,
}: ActivateAgentDialogProps) {
  const dispatch = useAppDispatch();
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const agents = useAppSelector((state) => selectAgentsInWorkspace(state, workspaceId));
  const directories = useAppSelector((state) => state.workspaces.directories);
  const readOnly = useAppSelector((state) => state.connection.readOnly);
  const terminalAvailable = useAppSelector((state) => state.connection.terminalAvailable);

  const directoryPaths = workspace?.directoryPaths ?? [];
  const canActivate = !readOnly && terminalAvailable;
  const occupiedDirectoryNames = new Set(agents.map((agent) => agent.directoryName));
  const hasAgent = (path: string) => {
    const name = directoryForPath(directories, path)?.name;
    return name !== undefined && occupiedDirectoryNames.has(name);
  };

  const activate = (directoryPath: string) => {
    dispatch(
      agentCreationRequested({
        workspaceId,
        name: '',
        directoryPath,
        start: true,
        permissionRoles: workspace?.permissionRoles ?? null,
        becomeCurator: false,
      }),
    );
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, pb: 0.5 }}>啟用 {workspaceName} 的 Agent</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 2 }}>
          選擇目錄，在該目錄啟用一個 Agent
        </Typography>
        {directoryPaths.length === 0 && (
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
            這個工作空間沒有目錄
          </Typography>
        )}
        {!canActivate && directoryPaths.length > 0 && (
          <Typography sx={{ fontSize: 11, color: 'warning.main', mb: 1 }}>
            目前無法啟用：唯讀連線或此主機沒有終端機
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {directoryPaths.map((path) => {
            const occupied = hasAgent(path);
            return (
              <ButtonBase
                key={path}
                disabled={!canActivate || occupied}
                onClick={() => activate(path)}
                sx={{
                  width: '100%',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  px: 1.5,
                  py: 1.25,
                  textAlign: 'left',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: '4px',
                  opacity: canActivate && !occupied ? 1 : 0.55,
                  '&:hover:not(.Mui-disabled)': { borderColor: 'primary.main' },
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap>
                    {directoryForPath(directories, path)?.name ?? path}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: '2px' }} noWrap>
                    {path}
                  </Typography>
                </Box>
                <Typography sx={{ flexShrink: 0, fontSize: 11, color: 'text.disabled' }}>
                  {occupied ? '已有 Agent' : '啟用'}
                </Typography>
              </ButtonBase>
            );
          })}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
