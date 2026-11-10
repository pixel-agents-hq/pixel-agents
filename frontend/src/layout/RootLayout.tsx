import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { serverToken } from '../features/connection/serverToken';

/** 路由切換會丟掉網址上的 token，這裡補回去，書籤才能持續有效。 */
function useKeepServerToken() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!serverToken) return;
    const params = new URLSearchParams(location.search);
    if (params.has('token')) return;
    params.set('token', serverToken);
    void navigate(
      { pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash },
      { replace: true },
    );
  }, [location.pathname, location.search, location.hash, navigate]);
}

export function RootLayout() {
  useKeepServerToken();
  return <Outlet />;
}
