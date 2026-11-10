import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectAgentsInWorkspace } from '../features/agents/agentSelectors';
import { agentCreationRequested } from '../features/agentCreation/createAgentSaga';
import { directoryEditRequested } from '../features/workspaces/editDirectorySaga';
import { directoryForPath, selectWorkspace } from '../features/workspaces/workspaceSelectors';

interface ActivateAgentDialogProps {
  workspaceId: string;
  workspaceName: string;
  open: boolean;
  onClose: () => void;
}

interface DirectoryEditFormProps {
  initialName: string;
  initialPath: string;
  onSubmit: (name: string, path: string) => void;
  onCancel: () => void;
}

function DirectoryEditForm({
  initialName,
  initialPath,
  onSubmit,
  onCancel,
}: DirectoryEditFormProps) {
  const [name, setName] = useState(initialName);
  const [path, setPath] = useState(initialPath);
  const trimmedPath = path.trim();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.5,
        border: 1,
        borderColor: 'primary.main',
        borderRadius: '4px',
      }}
    >
      <TextField
        size="small"
        label="名稱"
        helperText="留空則使用路徑的目錄名稱"
        value={name}
        onChange={(event) => setName(event.target.value)}
        slotProps={{ htmlInput: { maxLength: 64 } }}
      />
      <TextField
        size="small"
        label="路徑"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button size="small" onClick={onCancel} sx={{ color: 'text.secondary', fontSize: 11 }}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={trimmedPath === ''}
          onClick={() => onSubmit(name.trim(), trimmedPath)}
          sx={{ fontSize: 11 }}
        >
          儲存
        </Button>
      </Box>
    </Box>
  );
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
  const [editingPath, setEditingPath] = useState<string | null>(null);

  const directoryPaths = workspace?.directoryPaths ?? [];
  const canActivate = !readOnly && terminalAvailable;
  const occupiedDirectoryNames = new Set(agents.map((agent) => agent.directoryName));
  const hasAgent = (path: string) => {
    const name = directoryForPath(directories, path)?.name;
    return name !== undefined && occupiedDirectoryNames.has(name);
  };

  const saveEdit = (previousPath: string, name: string, path: string) => {
    dispatch(directoryEditRequested({ workspaceId, previousPath, name, path }));
    setEditingPath(null);
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
    <Dialog
      open={open}
      onClose={() => {
        setEditingPath(null);
        onClose();
      }}
      fullWidth
      maxWidth="xs"
    >
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
            const directory = directoryForPath(directories, path);
            if (editingPath === path) {
              return (
                <DirectoryEditForm
                  key={path}
                  initialName={directory?.name ?? ''}
                  initialPath={path}
                  onSubmit={(name, newPath) => saveEdit(path, name, newPath)}
                  onCancel={() => setEditingPath(null)}
                />
              );
            }
            const occupied = hasAgent(path);
            const editable = directory?.source === 'user' && !readOnly;
            return (
              <Box key={path} sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75 }}>
                <ButtonBase
                  disabled={!canActivate || occupied}
                  onClick={() => activate(path)}
                  sx={{
                    flex: 1,
                    minWidth: 0,
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
                      {directory?.name ?? path}
                    </Typography>
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: '2px' }} noWrap>
                      {path}
                    </Typography>
                  </Box>
                  <Typography sx={{ flexShrink: 0, fontSize: 11, color: 'text.disabled' }}>
                    {occupied ? '已有 Agent' : '啟用'}
                  </Typography>
                </ButtonBase>
                {editable && (
                  <Button
                    variant="outlined"
                    aria-label={`編輯 ${directory.name}`}
                    onClick={() => setEditingPath(path)}
                    sx={{ flexShrink: 0, fontSize: 11, px: 1.5 }}
                  >
                    編輯
                  </Button>
                )}
              </Box>
            );
          })}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
