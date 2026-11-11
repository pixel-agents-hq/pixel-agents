import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { Navigate } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { LAST_WORKSPACE_STORAGE_KEY } from '../constants';
import { selectVisibleWorkspaces } from '../features/workspaces/workspaceSelectors';

function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function HomeRedirect() {
  const loaded = useAppSelector((state) => state.workspaces.loaded);
  const workspaces = useAppSelector(selectVisibleWorkspaces);
  if (!loaded) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  const lastId = readLastWorkspace();
  const target = workspaces.find((workspace) => workspace.id === lastId) ?? workspaces[0];
  return <Navigate to={target ? `/w/${target.id}` : '/workspaces/new'} replace />;
}
