import { useCallback, useRef, useState } from 'react';

import type { SwipePanel } from './useEdgeSwipe.js';

/** The phone menu's state: open or shut, and the menu as a swipe panel
 *  (MobileMenu fills it, MobileShell's left-edge swipe drags it). */
export function useMobileMenu() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const swipe = useRef<SwipePanel>(null);
  return { open, show, close, swipe };
}
