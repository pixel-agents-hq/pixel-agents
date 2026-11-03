/**
 * The key bar's trackpad key: press, hold and slide to send arrow keys, one
 * per `step` px of travel, retracing when the finger backs up. The first
 * axis to cover a full step wins the press: from then on only that axis
 * sends keys (both ways along it), so a sideways slide that drifts a little
 * up never jumps to the line above. Pure, for the Node test runner.
 */

export type TrackpadArrow = 'up' | 'down' | 'left' | 'right';

export interface TrackpadState {
  /** The locked axis; null until the finger has covered a full step. */
  axis: 'x' | 'y' | null;
  /** Steps already sent along the locked axis (signed: right / down positive). */
  sent: number;
}

export const TRACKPAD_IDLE: TrackpadState = { axis: null, sent: 0 };

/** The arrows a finger now `dx`, `dy` px from where it pressed should send. */
export function trackpadMove(
  state: TrackpadState,
  dx: number,
  dy: number,
  step: number,
): { state: TrackpadState; keys: TrackpadArrow[] } {
  let axis = state.axis;
  if (axis === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < step) return { state, keys: [] };
    axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  }
  const keys: TrackpadArrow[] = [];
  let { sent } = state;
  const target = Math.trunc((axis === 'x' ? dx : dy) / step);
  const [forward, back]: [TrackpadArrow, TrackpadArrow] =
    axis === 'x' ? ['right', 'left'] : ['down', 'up'];
  for (; sent < target; sent++) keys.push(forward);
  for (; sent > target; sent--) keys.push(back);
  return { state: { axis, sent }, keys };
}
