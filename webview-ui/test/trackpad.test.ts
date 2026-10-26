/**
 * The key bar's trackpad: the first axis to cover a step owns the press.
 * Pure (touch/trackpad.ts), so each rule is one move script.
 */

import { describe, expect, it } from 'vitest';

import type { TrackpadArrow, TrackpadState } from '../src/touch/trackpad.js';
import { TRACKPAD_IDLE, trackpadMove } from '../src/touch/trackpad.js';

const STEP = 16;

/** Feed finger offsets (from the press point) in order; collect the arrows. */
function slide(moves: Array<[number, number]>): { state: TrackpadState; keys: TrackpadArrow[] } {
  let state = TRACKPAD_IDLE;
  const keys: TrackpadArrow[] = [];
  for (const [dx, dy] of moves) {
    const r = trackpadMove(state, dx, dy, STEP);
    state = r.state;
    keys.push(...r.keys);
  }
  return { state, keys };
}

describe('trackpad', () => {
  it('sends nothing until the finger covers a full step', () => {
    expect(slide([[10, 12]]).keys).toEqual([]);
  });

  it('a sideways slide that drifts up stays on the line', () => {
    const r = slide([
      [20, -4],
      [40, -12],
      [70, -30],
    ]);
    expect(r.state.axis).toBe('x');
    expect(r.keys).toEqual(['right', 'right', 'right', 'right']);
  });

  it('a vertical slide that drifts sideways only moves up and down', () => {
    expect(
      slide([
        [-5, 20],
        [-30, 40],
      ]).keys,
    ).toEqual(['down', 'down']);
  });

  it('goes both ways along the locked axis, retracing past the start', () => {
    expect(
      slide([
        [35, 0],
        [0, 3],
        [-20, 25],
      ]).keys,
    ).toEqual(['right', 'right', 'left', 'left', 'left']);
  });
});
