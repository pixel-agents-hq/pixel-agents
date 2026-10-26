import type { TransitionEvent } from 'react';
import { useEffect, useState } from 'react';

import { SIDE_PANEL_CLOSE_MS } from '../constants.js';
import { slideTransitions } from './slideTransitions.js';
import { prefersReducedMotion } from './usePresence.js';

export interface SlidePanel {
  /** Keep the panel laid out: true while open and until its close has played.
   *  The caller decides what false means (hide it, or unmount it). */
  rendered: boolean;
  /** The width target: the panel's full width when true, 0 when false. */
  shown: boolean;
  /** The clip box's `transition` (its width). */
  panelTransition: string;
  /** The contents' `transition` (their slide and fade). */
  contentTransition: string;
  /** The clip box's onTransitionEnd: ends the slide when its width settles. */
  onPanelTransitionEnd: (e: TransitionEvent<HTMLElement>) => void;
}

/**
 * The motion of a panel docked to a side of the office: opening stretches it
 * out (a touch past its width, settling back) with its contents sliding in
 * behind; closing fades them and snaps it shut. Under reduced motion it goes
 * at once. Opening spends one frame at width 0 first, or there is nothing to
 * animate from. The width only transitions while opening or closing, so a
 * drag-resize or a window resize follows the pointer instead of easing behind it.
 */
export function useSlidePanel(open: boolean, { initiallyOpen = false } = {}): SlidePanel {
  const [rendered, setRendered] = useState(initiallyOpen);
  const [shown, setShown] = useState(initiallyOpen);
  const [animating, setAnimating] = useState(false);
  const instant = prefersReducedMotion();

  useEffect(() => {
    if (open) {
      setRendered(true);
      if (instant) {
        setShown(true);
        return;
      }
      setAnimating(true);
      // One frame at width 0 first, or there is nothing to animate from.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setShown(false);
    if (instant) {
      setRendered(false);
      return;
    }
    setAnimating(true);
    // onPanelTransitionEnd ends the close when the slide does; this is the
    // backstop for a transition that never runs (a hidden tab), not the timing.
    const timer = setTimeout(() => {
      setRendered(false);
      setAnimating(false);
    }, SIDE_PANEL_CLOSE_MS * 2);
    return () => clearTimeout(timer);
  }, [open, instant]);

  const { panelTransition, contentTransition } = slideTransitions({ shown, animating, instant });

  const onPanelTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'width') return;
    setAnimating(false);
    if (!open) setRendered(false);
  };

  return { rendered, shown, panelTransition, contentTransition, onPanelTransitionEnd };
}
