import { useEffect, useState } from 'react';

import { MENU_POP_OUT_MS } from '../constants.js';

/**
 * Keeps something on screen while its closing animation plays: `mounted` is
 * true while it is open and for `MENU_POP_OUT_MS` after it shuts, with `closing` set
 * for that tail. Reopened mid-close, it simply stays (and replays its open).
 * Under reduced motion it goes at once.
 */
export function usePresence(open: boolean): { mounted: boolean; closing: boolean } {
  const [lingering, setLingering] = useState(open);

  useEffect(() => {
    if (open) {
      setLingering(true);
      return;
    }
    if (prefersReducedMotion()) {
      setLingering(false);
      return;
    }
    const timer = setTimeout(() => setLingering(false), MENU_POP_OUT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return { mounted: open || lingering, closing: !open && lingering };
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** The class that plays a menu's open or close (index.css, "Menu juice"). */
export function popClass(closing: boolean): string {
  return closing ? 'menu-pop-out' : 'menu-pop-in';
}
