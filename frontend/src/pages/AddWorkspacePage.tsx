import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { EventFlow } from '../components/EventFlow';
import type { EventFlowStep } from '../components/EventFlow';
import { FormField } from '../components/FormField';
import { useAwaitCreation } from '../features/agentCreation/useAwaitCreation';
import { workspaceCreationRequested } from '../features/workspaces/createWorkspaceSaga';

const FLOW_STEPS: EventFlowStep[] = [
  { label: 'submit', value: 'form data', tone: 'plain' },
  { label: 'send', value: 'saveDirectory', detail: '{name, path}', tone: 'send' },
  { label: 'receive', value: 'directorySaved', detail: 'Directory', tone: 'receive' },
  { label: 'send', value: 'saveWorkspace', detail: '{name, directoryPaths}', tone: 'send' },
  { label: 'receive', value: 'workspacesLoaded', detail: 'Workspace[]', tone: 'receive' },
  { label: 'navigate', value: '/w/:id', tone: 'plain' },
];

export function AddWorkspacePage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const workspaces = useAppSelector((state) => state.workspaces.workspaces);
  const readOnly = useAppSelector((state) => state.connection.readOnly);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');

  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const onCreated = useCallback((id: string) => void navigate(`/w/${id}`), [navigate]);
  const creation = useAwaitCreation(workspaceIds, onCreated);

  const submit = () => {
    creation.begin();
    dispatch(workspaceCreationRequested({ name: name.trim(), path: path.trim() }));
  };

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', px: 6, py: 4.5 }}>
      <Box sx={{ width: '100%', maxWidth: 480 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3.5 }}>
          <Button
            variant="outlined"
            component={RouterLink}
            to="/"
            aria-label="返回"
            sx={{ minWidth: 0, width: 28, height: 28, p: 0, fontSize: 15 }}
          >
            ‹
          </Button>
          <Typography variant="h6">New Workspace</Typography>
        </Box>

        <FormField label="Name" hint="工作空間的顯示名稱">
          <TextField
            fullWidth
            size="small"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>

        <FormField label="Path" hint="專案目錄的絕對路徑">
          <TextField
            fullWidth
            size="small"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            sx={{ '& input': { fontSize: 12 } }}
          />
        </FormField>

        <EventFlow steps={FLOW_STEPS} />

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="contained"
            disabled={readOnly || creation.pending || name.trim() === '' || path.trim() === ''}
            onClick={submit}
            sx={{ px: 2.5, py: 1, fontSize: 13 }}
          >
            {creation.pending ? 'Creating…' : 'Create Workspace'}
          </Button>
          <Button component={RouterLink} to="/" sx={{ color: 'text.secondary', fontSize: 13 }}>
            Cancel
          </Button>
        </Box>
        {readOnly && (
          <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: 1.5 }}>
            目前是唯讀連線，無法建立工作空間
          </Typography>
        )}
      </Box>
    </Box>
  );
}
