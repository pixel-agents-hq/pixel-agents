import { TOUCH_TAP_MAX_MOVE_PX } from '../constants.js';

/** Minimal Touch shape the helpers need — structural so the pure gesture
 *  reducers that use them run on the Node test runner (no DOM types). */
export interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

/** A TouchList, structurally — what findTouch searches. */
export interface TouchListLike<T extends TouchPoint = TouchPoint> {
  length: number;
  [index: number]: T;
}

/**
 * The touch with `id` in `list`, or null. Every gesture here tracks ONE
 * finger by identifier rather than reading `touches[0]`: with a second
 * finger resting on the glass (a palm graze, the other thumb), index 0 can
 * be the wrong finger, and bailing on `touches.length !== 1` stalls the
 * gesture outright.
 */
export function findTouch<T extends TouchPoint>(list: TouchListLike<T>, id: number): T | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

/** True while a finger that moved (dx, dy) from its start is still a tap.
 *  The one slop metric every touch surface in the app uses. */
export function withinTapSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) <= TOUCH_TAP_MAX_MOVE_PX;
}
