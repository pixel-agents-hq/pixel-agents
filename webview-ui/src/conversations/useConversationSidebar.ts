import { useCallback, useState } from 'react';

import { CONVERSATION_SIDEBAR_SHUT_KEY } from '../constants.js';

export interface ConversationSidebar {
  /** Whether this office has the sidebar at all. */
  hasSidebar: boolean;
  open: boolean;
  /** The zoom stack's top button: show or hide it (remembered per browser). */
  toggle: () => void;
}

/**
 * The desktop conversation sidebar. Resuming needs a terminal, so only a
 * tokened standalone office lists past conversations. Open unless this
 * browser last shut it.
 */
export function useConversationSidebar(
  terminalAvailable: boolean,
  officeReadOnly: boolean,
): ConversationSidebar {
  const [open, setOpen] = useState(() => !storedSidebarShut());
  const toggle = useCallback(() => {
    const next = !open;
    storeSidebarShut(!next);
    setOpen(next);
  }, [open]);
  return { hasSidebar: terminalAvailable && !officeReadOnly, open, toggle };
}

function storedSidebarShut(): boolean {
  try {
    return localStorage.getItem(CONVERSATION_SIDEBAR_SHUT_KEY) === '1';
  } catch {
    return false;
  }
}

function storeSidebarShut(shut: boolean): void {
  try {
    if (shut) localStorage.setItem(CONVERSATION_SIDEBAR_SHUT_KEY, '1');
    else localStorage.removeItem(CONVERSATION_SIDEBAR_SHUT_KEY);
  } catch {
    // Not remembered; it still opens and shuts.
  }
}
