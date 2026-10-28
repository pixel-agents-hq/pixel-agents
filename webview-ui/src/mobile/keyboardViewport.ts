/**
 * Is the software keyboard up, and must the mobile shell be clamped to the
 * visual viewport? A pure decision over viewport samples, so it runs on the
 * Node test runner; useKeyboardViewport feeds it.
 *
 * The two questions are separate because browsers resize differently:
 *
 * - iOS Safari: only the VISUAL viewport shrinks; innerHeight (and 100dvh)
 *   keep the keyboard-covered area. The keyboard is up AND the shell must be
 *   clamped to visualViewport.height, or the prompt hides under the keys.
 * - Android, `interactive-widget=resizes-content` (index.html): the layout
 *   viewport shrinks too, so innerHeight === visualViewport.height. The shell
 *   already fits; nothing to clamp — but the keyboard is still up.
 *
 * So "open" can't be read off innerHeight vs visualViewport: it is measured
 * against a per-width baseline — the tallest viewport seen at the current
 * width (a rotation changes the width, and gets its own baseline). Open =
 * an editable element has focus (the keyboard only serves one) AND the
 * visual viewport is at least KEYBOARD_MIN_HEIGHT_PX below the baseline (an
 * address bar collapsing or expanding moves it by far less).
 */

import { KEYBOARD_MIN_HEIGHT_PX, VISUAL_VIEWPORT_FULL_EPSILON_PX } from '../constants.js';

export interface ViewportSample {
  /** window.innerWidth — keys the baseline (orientation). */
  width: number;
  /** window.innerHeight (layout viewport). */
  innerHeight: number;
  /** visualViewport.height. */
  visualHeight: number;
  /** An editable element (xterm's helper textarea, an input) has focus. */
  editableFocused: boolean;
}

/** Tallest viewport height seen per width. */
export type ViewportBaselines = ReadonlyMap<number, number>;

export interface KeyboardViewport {
  keyboardOpen: boolean;
  /** Height to clamp the shell to (iOS), or null when the layout viewport
   *  already matches the visible area (keyboard down, or Android resizing). */
  clampHeight: number | null;
}

export function readKeyboardViewport(
  baselines: ViewportBaselines,
  sample: ViewportSample,
): { baselines: ViewportBaselines; viewport: KeyboardViewport } {
  const width = Math.round(sample.width);
  const tallest = Math.max(sample.innerHeight, sample.visualHeight);
  const baseline = Math.max(baselines.get(width) ?? 0, tallest);
  const next =
    baseline === baselines.get(width) ? baselines : new Map(baselines).set(width, baseline);
  const keyboardOpen =
    sample.editableFocused && baseline - sample.visualHeight >= KEYBOARD_MIN_HEIGHT_PX;
  const clamped =
    keyboardOpen && sample.visualHeight < sample.innerHeight - VISUAL_VIEWPORT_FULL_EPSILON_PX;
  return {
    baselines: next,
    viewport: { keyboardOpen, clampHeight: clamped ? Math.round(sample.visualHeight) : null },
  };
}

export const KEYBOARD_CLOSED: KeyboardViewport = { keyboardOpen: false, clampHeight: null };
