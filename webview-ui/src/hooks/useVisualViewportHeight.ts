import { useEffect, useState } from 'react';

import { VISUAL_VIEWPORT_FULL_EPSILON_PX } from '../constants.js';

/**
 * Height of the visual viewport while the software keyboard is open, or null
 * when it isn't (or the API is unavailable).
 *
 * iOS Safari never resizes the layout viewport for the keyboard — 100dvh and
 * window.innerHeight both keep the keyboard-covered area, so a full-height
 * terminal keeps its prompt hidden under the keys. Clamping the mobile shell
 * to this height shrinks the terminal pane, whose ResizeObserver re-fits
 * xterm and resizes the PTY — the TUI redraws with its input line visible.
 */
export function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHeight(null);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const keyboardClosed = vv.height >= window.innerHeight - VISUAL_VIEWPORT_FULL_EPSILON_PX;
      setHeight(keyboardClosed ? null : Math.round(vv.height));
      // Focusing xterm's hidden textarea makes iOS scroll the page to reveal
      // it; with the shell clamped to the visual viewport that scroll only
      // misaligns the fixed layout, so pin it back.
      if (!keyboardClosed) window.scrollTo(0, 0);
    };

    // Dismissing the keyboard starts with the focused input blurring, but iOS
    // only fires the visualViewport resize AFTER the hide animation — leaving
    // the clamped shell floating above a gap for ~300ms. Un-clamp on focusout
    // immediately so the shell expands in step with the keyboard sliding away.
    // If focus just moved to another input (keyboard stays up), the focusin
    // re-runs update() and re-clamps from the still-small viewport.
    const onFocusOut = () => setHeight(null);
    const onFocusIn = () => update();

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('focusout', onFocusOut);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [enabled]);

  return height;
}
