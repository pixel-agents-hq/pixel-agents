import { useCallback, useState } from 'react';

import { CASCADE_PANEL_STORAGE_KEY } from '../constants.js';

function readStored(): boolean {
  try {
    return localStorage.getItem(CASCADE_PANEL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Cascade panel open/closed, remembered per viewer in localStorage (which may
 *  be unavailable or full: then it just does not persist). With `restore` off
 *  (phones, where the panel is a sheet over the office) it always starts closed. */
export function useCascadePanelOpen(restore: boolean): [boolean, () => void] {
  const [isOpen, setIsOpen] = useState(() => restore && readStored());
  const toggle = useCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    try {
      localStorage.setItem(CASCADE_PANEL_STORAGE_KEY, String(next));
    } catch {
      // Not persisted; the panel still toggles.
    }
  }, [isOpen]);
  return [isOpen, toggle];
}
