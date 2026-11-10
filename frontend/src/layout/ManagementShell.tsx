import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import { Outlet } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { rejectionDismissed } from '../features/connection/connectionSlice';
import { ManagementSidebar } from './ManagementSidebar';

interface ManagementShellProps {
  placeholder?: string;
}

export function ManagementShell({ placeholder }: ManagementShellProps) {
  const dispatch = useAppDispatch();
  const loaded = useAppSelector((state) => state.workspaces.loaded);
  const rejection = useAppSelector((state) => state.connection.rejection);

  if (!loaded) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <ManagementSidebar placeholder={placeholder} />
      <Box
        sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {rejection && (
          <Alert
            severity="error"
            onClose={() => dispatch(rejectionDismissed())}
            sx={{ borderRadius: 0 }}
          >
            {rejection}
          </Alert>
        )}
        <Outlet />
      </Box>
    </Box>
  );
}
