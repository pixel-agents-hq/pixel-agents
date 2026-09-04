import { useEffect, useState } from 'react';

import { MOBILE_MEDIA_QUERY } from '../constants.js';

/**
 * Whether the viewport should get the mobile shell (sliding office/terminal
 * pages + bottom card bar) instead of the desktop drawer layout.
 *
 * Live: rotation or a window resize across the breakpoint re-renders. The
 * terminal panes remount when the shell swaps — their sockets reconnect and
 * the server replays the serialized screen, so nothing is lost beyond local
 * scrollback.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
