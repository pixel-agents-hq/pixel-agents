import { useEffect, useRef } from 'react';

interface HoverPinInputs {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** How long after the pointer leaves it shuts; 0 shuts at once. */
  closeDelayMs: number;
  /** While true, the pointer leaving doesn't shut it (only a press elsewhere does). */
  holdOpen?: () => boolean;
}

/**
 * A desktop menu that hovering opens and leaving shuts again: a press pins it
 * open (the press that follows a hover pins rather than shuts), and a second
 * press while pinned shuts it. `keep` cancels a pending close, for a panel the
 * pointer may travel into on its way from the button.
 */
export function useHoverPin({ isOpen, open, close, closeDelayMs, holdOpen }: HoverPinInputs) {
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return {
    keep,
    enter: () => {
      keep();
      if (isOpen) return;
      pinned.current = false;
      open();
    },
    leave: () => {
      keep();
      if (pinned.current || holdOpen?.()) return;
      if (closeDelayMs <= 0) close();
      else closeTimer.current = setTimeout(close, closeDelayMs);
    },
    press: () => {
      keep();
      if (isOpen && pinned.current) {
        close();
        return;
      }
      pinned.current = true;
      open();
    },
  };
}
