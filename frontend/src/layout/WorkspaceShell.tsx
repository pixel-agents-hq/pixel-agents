import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { LAST_WORKSPACE_STORAGE_KEY } from '../constants';
import { noticeFrom } from '../features/agentCreation/creationNotice';
import { rejectionDismissed } from '../features/connection/connectionSlice';
import { selectWorkspace } from '../features/workspaces/workspaceSelectors';
import { NotFoundPage } from '../pages/NotFoundPage';
import { Sidebar } from './Sidebar';

function rememberWorkspace(workspaceId: string) {
  try {
    localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // 無痕模式等情境無法寫入時，只是不記住上次的工作空間
  }
}

export function WorkspaceShell() {
  const dispatch = useAppDispatch();
  const { workspaceId = '' } = useParams();
  const loaded = useAppSelector((state) => state.workspaces.loaded);
  const workspace = useAppSelector((state) => selectWorkspace(state, workspaceId));
  const rejection = useAppSelector((state) => state.connection.rejection);
  const location = useLocation();
  const navigate = useNavigate();
  // 從 New Agent 頁導過來時，這個殼是新掛載的，所以只需要在掛載時讀一次導覽帶來的訊息。
  const [notice, setNotice] = useState<string | null>(() => noticeFrom(location.state));

  useEffect(() => {
    if (workspace) rememberWorkspace(workspace.id);
  }, [workspace]);

  // 成功訊息只顯示一次：清掉 history state，重新整理不會再出現。
  useEffect(() => {
    if (noticeFrom(location.state) === null) return;
    void navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location, navigate]);

  if (!loaded) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (!workspace) {
    return <NotFoundPage message={`找不到工作空間「${workspaceId}」`} homeTo="/" />;
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar workspaceId={workspace.id} />
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
      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  );
}
