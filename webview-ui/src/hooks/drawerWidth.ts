import {
  OFFICE_MIN_WIDTH_PX,
  TERMINAL_DRAWER_MAX_WIDTH_RATIO,
  TERMINAL_DRAWER_MIN_WIDTH_PX,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';

/**
 * The drawer width that fits a viewport: the office keeps at least the card
 * bar's width (the cards overlay its right edge, and they are the only way to
 * switch agents), so on a narrow screen the minimum gives way to that. Where
 * there is room, the drawer also leaves the office OFFICE_MIN_WIDTH_PX (its
 * toolbar and the radio side by side) of what `besidePx` doesn't take, down
 * to the drawer's own minimum.
 */
export function clampDrawerWidth(preferredPx: number, viewportPx: number, besidePx = 0): number {
  const maxPx = Math.min(
    viewportPx * TERMINAL_DRAWER_MAX_WIDTH_RATIO,
    viewportPx - TERMINAL_SIDEBAR_WIDTH_PX,
    Math.max(TERMINAL_DRAWER_MIN_WIDTH_PX, viewportPx - besidePx - OFFICE_MIN_WIDTH_PX),
  );
  return Math.max(0, Math.min(maxPx, Math.max(TERMINAL_DRAWER_MIN_WIDTH_PX, preferredPx)));
}
