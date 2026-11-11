/**
 * The phone player's sheet gesture, DOM-free: one finger drags the player up
 * from the hint or down from the player, and the release settles it open or
 * shut — a flick goes the way it was thrown, a slow drag the way of the half
 * it was let go in. MusicPlayer's usePlayerSheet is the DOM adapter.
 */

import { MUSIC_FLICK_MAX_AGE_MS, MUSIC_FLICK_PX_PER_MS } from '../constants.js';
import { type TouchPoint, withinTapSlop } from '../touch/touchPrimitives.js';

/** One finger's drag. Updated in place by moveSheetDrag. */
export interface SheetDrag {
  id: number;
  x0: number;
  y0: number;
  /** Where the player stood when the finger landed: 0 out, `travel` tucked away. */
  base: number;
  travel: number;
  /** null until the finger leaves the tap slop; then whether it moves up/down. */
  vertical: boolean | null;
  lastY: number;
  lastT: number;
  /** The finger's latest speed down the screen, px/ms. */
  vy: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A finger lands at time `t` (ms) on a player that is `shown` or tucked
 *  `travel` px away. */
export function startSheetDrag(
  touch: TouchPoint,
  t: number,
  shown: boolean,
  travel: number,
): SheetDrag {
  return {
    id: touch.identifier,
    x0: touch.clientX,
    y0: touch.clientY,
    base: shown ? 0 : travel,
    travel,
    vertical: null,
    lastY: touch.clientY,
    lastT: t,
    vy: 0,
  };
}

/** The finger moves: the player's offset (0 out .. `travel` tucked away), or
 *  null while the finger is still inside the tap slop or once the drag locked
 *  sideways (the first move out of the slop decides). */
export function moveSheetDrag(
  d: SheetDrag,
  touch: TouchPoint,
  t: number,
): { offset: number } | null {
  const dx = touch.clientX - d.x0;
  const dy = touch.clientY - d.y0;
  if (d.vertical === null) {
    if (withinTapSlop(dx, dy)) return null;
    d.vertical = Math.abs(dy) > Math.abs(dx);
  }
  if (!d.vertical) return null;
  const dt = t - d.lastT;
  if (dt > 0) d.vy = (touch.clientY - d.lastY) / dt;
  d.lastY = touch.clientY;
  d.lastT = t;
  return { offset: clamp(d.base + dy, 0, d.travel) };
}

/** The finger lifts: whether the player settles out (true) or tucked away
 *  (false), or null when the drag never went vertical (a tap, or sideways). */
export function releaseSheetDrag(d: SheetDrag, touch: TouchPoint, t: number): boolean | null {
  if (!d.vertical) return null;
  const at = clamp(d.base + touch.clientY - d.y0, 0, d.travel);
  // A finger that rested before lifting threw nothing.
  const vy = t - d.lastT > MUSIC_FLICK_MAX_AGE_MS ? 0 : d.vy;
  return vy < -MUSIC_FLICK_PX_PER_MS
    ? true
    : vy > MUSIC_FLICK_PX_PER_MS
      ? false
      : at < d.travel / 2;
}
