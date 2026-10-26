import {
  SIDE_PANEL_CLOSE_EASE,
  SIDE_PANEL_CLOSE_MS,
  SIDE_PANEL_CONTENT_DELAY_MS,
  SIDE_PANEL_OPEN_EASE,
  SIDE_PANEL_OPEN_MS,
} from '../constants.js';

/**
 * The two `transition` values for a panel's state (pure). The width only
 * transitions while opening or closing (`animating`), so a resize follows the
 * pointer. The contents' slide and fade run SIDE_PANEL_CONTENT_DELAY_MS behind
 * the width, past the moment `animating` ends, so their transition stays on
 * whenever motion is allowed: it names only transform and opacity, which
 * change with `shown` alone, so a resize never eases through it.
 */
export function slideTransitions({
  shown,
  animating,
  instant,
}: {
  shown: boolean;
  animating: boolean;
  instant: boolean;
}): { panelTransition: string; contentTransition: string } {
  const panelTransition =
    instant || !animating
      ? 'none'
      : shown
        ? `width ${SIDE_PANEL_OPEN_MS}ms ${SIDE_PANEL_OPEN_EASE}`
        : `width ${SIDE_PANEL_CLOSE_MS}ms ${SIDE_PANEL_CLOSE_EASE}`;
  const contentTransition = instant
    ? 'none'
    : shown
      ? `transform ${SIDE_PANEL_OPEN_MS}ms ${SIDE_PANEL_OPEN_EASE} ${SIDE_PANEL_CONTENT_DELAY_MS}ms, opacity ${SIDE_PANEL_OPEN_MS}ms ease-out ${SIDE_PANEL_CONTENT_DELAY_MS}ms`
      : `transform ${SIDE_PANEL_CLOSE_MS}ms ease-in, opacity ${SIDE_PANEL_CLOSE_MS / 2}ms ease-in`;
  return { panelTransition, contentTransition };
}
