import { useCallback, useState } from 'react';

import { CONVERSATION_SIDEBAR_OPEN_KEY } from '../constants.js';

export interface ConversationSidebar {
  /** Whether this office has the sidebar at all. */
  hasSidebar: boolean;
  open: boolean;
  /** The zoom stack's top button: show or hide it (remembered per browser). */
  toggle: () => void;
}

/**
 * The desktop conversation sidebar. Resuming needs a terminal, so only a
 * tokened standalone office lists past conversations. Shut until this
 * browser opens it, and it stays as this browser last left it.
 */
export function useConversationSidebar(
  terminalAvailable: boolean,
  officeReadOnly: boolean,
): ConversationSidebar {
  const [open, setOpen] = useState(storedSidebarOpen);
  const toggle = useCallback(() => {
    const next = !open;
    storeSidebarOpen(next);
    setOpen(next);
  }, [open]);
  return { hasSidebar: terminalAvailable && !officeReadOnly, open, toggle };
}

function storedSidebarOpen(): boolean {
  try {
    return localStorage.getItem(CONVERSATION_SIDEBAR_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function storeSidebarOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(CONVERSATION_SIDEBAR_OPEN_KEY, '1');
    else localStorage.removeItem(CONVERSATION_SIDEBAR_OPEN_KEY);
  } catch {
    // Not remembered; it still opens and shuts.
  }
}
