import { useEffect, useState } from 'react';

import { MOBILE_MEDIA_QUERY } from '../constants.js';
import { isBrowserRuntime } from '../runtime.js';

/**
 * Whether the viewport should get the mobile shell (sliding office/terminal
 * pages + bottom card bar) instead of the desktop drawer layout.
 *
 * Standalone (browser) only. The VS Code webview always gets the desktop
 * layout: a docked panel routinely sits under the phone breakpoint (a fresh
 * side-docked panel opens at ~300px), and the mobile shell is built around
 * the embedded terminal, which the VS Code host does not have — so there it
 * would only hide the toolbar. Runtime detection lives in runtime.ts.
 *
 * Live: rotation or a window resize across the breakpoint re-renders. The
 * terminal panes remount when the shell swaps — their sockets reconnect and
 * the server replays the serialized screen, so nothing is lost beyond local
 * scrollback.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => isBrowserRuntime && window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    if (!isBrowserRuntime) return;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
