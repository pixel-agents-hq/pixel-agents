import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { Navigate } from 'react-router';

import { useAppSelector } from '../app/hooks';
import { DEFAULT_WORKSPACE_ID } from '../protocol';
import { LAST_WORKSPACE_STORAGE_KEY } from '../constants';

function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function HomeRedirect() {
  const { loaded, workspaces } = useAppSelector((state) => state.workspaces);
  if (!loaded) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  const candidates = [readLastWorkspace(), DEFAULT_WORKSPACE_ID, workspaces[0]?.id];
  const target = candidates.find((id) => id && workspaces.some((workspace) => workspace.id === id));
  return <Navigate to={target ? `/w/${target}` : '/not-found'} replace />;
}
