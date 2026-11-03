/**
 * The key bar's trackpad key: press, hold and slide to send arrow keys, one
 * per step of travel along the slide's axis, retracing when the finger backs
 * up. Left/right steps are shorter than up/down ones (a line holds far more
 * columns than a menu holds rows).
 *
 * One axis owns the slide, so a sideways slide that drifts a little up never
 * jumps a line. The choice is made at a PIVOT: the first `decidePx` of
 * travel from it go to whichever axis covers them. The press point is the
 * first pivot; after that, a pause — the finger slowing below `pauseSpeed` —
 * makes the spot it rested on a new one, so going right, resting, then going
 * down switches to up/down. Carrying on the same way after a pause keeps
 * every step already made.
 *
 * Left/right accelerates toward the screen edges: given how far the press
 * point is from each edge (`reach`) and how many columns a line holds
 * (`lineCols`), a drag all the way to an edge sends a full line, while the
 * first steps stay one column each. Pure, for the Node test runner.
 */

export type TrackpadArrow = 'up' | 'down' | 'left' | 'right';

export interface TrackpadConfig {
  /** Finger travel per left/right arrow. */
  stepX: number;
  /** Finger travel per up/down arrow. */
  stepY: number;
  /** Travel from a pivot that decides (or re-decides) the axis. */
  decidePx: number;
  /** Below this speed (px/ms) the finger counts as resting: a new pivot. */
  pauseSpeed: number;
  /** Distance from the press point to the left and right screen edges. */
  reach?: { left: number; right: number };
  /** Columns in a line: the left/right arrows a drag to an edge sends. */
  lineCols?: number;
}

/**
 * Left/right arrows for `travel` px from the anchor. Linear (one per
 * `stepX`) plus a quadratic term fitted so travel reaching the screen edge
 * on that side sends `lineCols`: the curve is nearly flat near the anchor
 * (fine control) and steepens toward the edge. Without a reach or line, or
 * when the line is short enough for the linear pace, it stays linear.
 */
function columnsFor(travel: number, anchorX: number, config: TrackpadConfig): number {
  const d = Math.abs(travel);
  let n = d / config.stepX;
  const { reach, lineCols } = config;
  if (reach && lineCols) {
    // The edge on this side, measured from the anchor (it moves at a pivot).
    const edge = travel >= 0 ? reach.right - anchorX : reach.left + anchorX;
    if (edge >= config.stepX) {
      const extra = Math.max(0, (lineCols - edge / config.stepX) / (edge * edge));
      n += extra * d * d;
    }
  }
  // The epsilon keeps an exact landing (the edge) from flooring one short.
  return Math.sign(travel) * Math.trunc(n + 1e-9);
}

interface Point {
  x: number;
  y: number;
}

export interface TrackpadState {
  /** The axis sending keys; null until the first pivot decides. */
  axis: 'x' | 'y' | null;
  /** Where the current axis's count starts. */
  anchor: Point;
  /** Steps sent along the axis, from the anchor (signed: right / down positive). */
  sent: number;
  /** An undecided pivot: the axis may still switch here. */
  pivot: Point | null;
  /** The previous move, for the finger's speed. */
  last: (Point & { t: number }) | null;
}

export const TRACKPAD_IDLE: TrackpadState = {
  axis: null,
  anchor: { x: 0, y: 0 },
  sent: 0,
  pivot: { x: 0, y: 0 },
  last: null,
};

/** The arrows a finger now `dx`, `dy` px from where it pressed, at time `t` ms, should send. */
export function trackpadMove(
  state: TrackpadState,
  dx: number,
  dy: number,
  t: number,
  config: TrackpadConfig,
): { state: TrackpadState; keys: TrackpadArrow[] } {
  let { axis, anchor, sent, pivot } = state;
  const { last } = state;

  // A rest opens a pivot where the finger rested.
  if (pivot === null && last !== null && t > last.t) {
    const speed = Math.hypot(dx - last.x, dy - last.y) / (t - last.t);
    if (speed < config.pauseSpeed) pivot = { x: last.x, y: last.y };
  }

  // Decide at the pivot once the finger has covered decidePx from it.
  if (pivot !== null) {
    const px = Math.abs(dx - pivot.x);
    const py = Math.abs(dy - pivot.y);
    if (Math.max(px, py) >= config.decidePx) {
      const chosen = px >= py ? 'x' : 'y';
      if (chosen !== axis) {
        // A new axis counts from the pivot.
        axis = chosen;
        anchor = pivot;
        sent = 0;
      }
      pivot = null;
    }
  }

  const keys: TrackpadArrow[] = [];
  if (axis !== null) {
    const target =
      axis === 'x'
        ? columnsFor(dx - anchor.x, anchor.x, config)
        : Math.trunc((dy - anchor.y) / config.stepY);
    const [forward, back]: [TrackpadArrow, TrackpadArrow] =
      axis === 'x' ? ['right', 'left'] : ['down', 'up'];
    for (; sent < target; sent++) keys.push(forward);
    for (; sent > target; sent--) keys.push(back);
  }
  return { state: { axis, anchor, sent, pivot, last: { x: dx, y: dy, t } }, keys };
}
