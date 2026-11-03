import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef } from 'react';

import { EDIT_LONG_PRESS_MAX_MOVE_PX, EDIT_LONG_PRESS_MS } from '../constants.js';

export interface LongPress {
  /** Spread onto the pressed element. */
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
  };
  /** Call first in the element's click handler: true when the click is the
   *  finger lifting after a long press, which must not ALSO count as a tap. */
  consumeClick: () => boolean;
}

/**
 * A touch long-press: `onLongPress` fires after EDIT_LONG_PRESS_MS with
 * the finger held still. Touch only — a mouse has hover, so it gets a visible
 * affordance instead. `enabled` false turns the press off.
 */
export function useLongPress(onLongPress: () => void, enabled = true): LongPress {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    origin.current = null;
  };

  useEffect(() => cancel, []);

  return {
    handlers: {
      onPointerDown: (e) => {
        if (!enabled || e.pointerType !== 'touch') return;
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          fired.current = true;
          callback.current();
        }, EDIT_LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        if (origin.current === null) return;
        const moved = Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y);
        if (moved > EDIT_LONG_PRESS_MAX_MOVE_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
    },
    consumeClick: () => {
      if (!fired.current) return false;
      fired.current = false;
      return true;
    },
  };
}
