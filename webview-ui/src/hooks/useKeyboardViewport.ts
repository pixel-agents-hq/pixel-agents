import { useEffect, useRef, useState } from 'react';

import type { KeyboardViewport, ViewportBaselines } from '../mobile/keyboardViewport.js';
import { KEYBOARD_CLOSED, readKeyboardViewport } from '../mobile/keyboardViewport.js';

/** Inputs that never raise a software keyboard. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'submit',
]);

function editableFocused(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Whether the software keyboard is up (the mobile key bar shows), and the
 * height to clamp the shell to while it is (null when nothing needs
 * clamping). The decision is readKeyboardViewport (mobile/keyboardViewport.ts);
 * this hook only samples the viewport.
 *
 * iOS Safari never resizes the layout viewport for the keyboard — 100dvh and
 * window.innerHeight both keep the keyboard-covered area, so a full-height
 * terminal keeps its prompt hidden under the keys. Clamping the mobile shell
 * to the visual viewport shrinks the terminal pane, whose ResizeObserver
 * re-fits xterm and resizes the PTY — the TUI redraws with its input line
 * visible. Android (`interactive-widget=resizes-content`) shrinks the layout
 * viewport itself: no clamp, but the keyboard is up all the same.
 */
export function useKeyboardViewport(enabled: boolean): KeyboardViewport {
  const [viewport, setViewport] = useState<KeyboardViewport>(KEYBOARD_CLOSED);
  const baselines = useRef<ViewportBaselines>(new Map());

  useEffect(() => {
    if (!enabled) {
      setViewport(KEYBOARD_CLOSED);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const r = readKeyboardViewport(baselines.current, {
        width: window.innerWidth,
        innerHeight: window.innerHeight,
        visualHeight: vv.height,
        editableFocused: editableFocused(),
      });
      baselines.current = r.baselines;
      setViewport((prev) =>
        prev.keyboardOpen === r.viewport.keyboardOpen && prev.clampHeight === r.viewport.clampHeight
          ? prev
          : r.viewport,
      );
      // Focusing xterm's hidden textarea makes iOS scroll the page to reveal
      // it; with the shell clamped to the visual viewport that scroll only
      // misaligns the fixed layout, so pin it back.
      if (r.viewport.clampHeight !== null) window.scrollTo(0, 0);
    };

    // Dismissing the keyboard starts with the focused input blurring, but iOS
    // only fires the visualViewport resize AFTER the hide animation — leaving
    // the clamped shell floating above a gap for ~300ms. Re-read on focusout:
    // nothing editable has focus during it, so the reading is "closed" and
    // the shell expands in step with the keyboard sliding away. If focus just
    // moved to another input (keyboard stays up), the focusin re-reads and
    // re-clamps from the still-small viewport.
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('focusout', update);
    window.addEventListener('focusin', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('focusout', update);
      window.removeEventListener('focusin', update);
    };
  }, [enabled]);

  return viewport;
}
