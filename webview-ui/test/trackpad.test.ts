/**
 * The key bar's trackpad: one axis owns the slide, and only a pause (the
 * finger slowing almost to a stop) reopens the choice. Pure
 * (touch/trackpad.ts), so each rule is one move script.
 */

import { describe, expect, it } from 'vitest';

import type { TrackpadArrow, TrackpadConfig, TrackpadState } from '../src/touch/trackpad.js';
import { TRACKPAD_IDLE, trackpadMove } from '../src/touch/trackpad.js';

const CONFIG: TrackpadConfig = { stepX: 8, stepY: 16, decidePx: 12, pauseSpeed: 0.05 };

/** Feed [dx, dy, t] finger offsets (from the press point) in order; collect the arrows. */
function slide(
  moves: Array<[number, number, number?]>,
  config: TrackpadConfig = CONFIG,
): {
  state: TrackpadState;
  keys: TrackpadArrow[];
} {
  let state = TRACKPAD_IDLE;
  const keys: TrackpadArrow[] = [];
  // Without an explicit time, moves come every 16 ms (a steady slide).
  moves.forEach(([dx, dy, t], i) => {
    const r = trackpadMove(state, dx, dy, t ?? i * 16, config);
    state = r.state;
    keys.push(...r.keys);
  });
  return { state, keys };
}

describe('trackpad', () => {
  it('sends nothing until the finger has travelled far enough to pick an axis', () => {
    expect(slide([[9, 10]]).keys).toEqual([]);
  });

  it('left and right are twice as fast as up and down', () => {
    expect(
      slide([
        [0, 0],
        [32, 0],
      ]).keys,
    ).toEqual(['right', 'right', 'right', 'right']);
    expect(
      slide([
        [0, 0],
        [0, 32],
      ]).keys,
    ).toEqual(['down', 'down']);
  });

  it('a fast sideways slide that drifts up stays on the line', () => {
    const r = slide([
      [20, -4],
      [40, -12],
      [70, -30],
    ]);
    expect(r.state.axis).toBe('x');
    expect(r.keys).toEqual(Array(8).fill('right'));
  });

  it('a fast vertical slide that drifts sideways only moves up and down', () => {
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
        [17, 0],
        [0, 3],
        [-10, 9],
      ]).keys,
    ).toEqual(['right', 'right', 'left', 'left', 'left']);
  });

  it('a pause opens the deadzone: the next stretch can switch to the other axis', () => {
    const r = slide([
      [0, 0, 0],
      [16, 0, 16], // right x2
      [16, 1, 400], // the finger rests: slow
      [18, 16, 420], // then heads down from the rest point
      [18, 32, 436],
    ]);
    expect(r.keys).toEqual(['right', 'right', 'down', 'down']);
    expect(r.state.axis).toBe('y');
  });

  it('after a pause, carrying on the same way keeps every step already made', () => {
    const r = slide([
      [0, 0, 0],
      [12, 0, 16], // right (1 step, 4 px into the next)
      [12, 0, 400], // pause
      [16, 0, 416], // 4 more px: the second step, not a fresh count
    ]);
    expect(r.keys).toEqual(['right', 'right']);
    expect(r.state.axis).toBe('x');
  });

  it('a slow, steady slide keeps sending on its axis', () => {
    const moves: Array<[number, number, number]> = [];
    for (let i = 0; i <= 40; i++) moves.push([i, 0, i * 40]); // 25 px/s
    expect(slide(moves).keys).toEqual(Array(5).fill('right'));
  });

  it('without a pause the axis never switches, however far the other way', () => {
    expect(
      slide([
        [0, 0],
        [16, 0],
        [16, 60],
      ]).keys,
    ).toEqual(['right', 'right']);
  });

  describe('acceleration toward the screen edges', () => {
    // Pressed 180 px from each edge; a full line is 60 columns.
    const ACCEL: TrackpadConfig = { ...CONFIG, reach: { left: 180, right: 180 }, lineCols: 60 };
    const count = (keys: TrackpadArrow[], k: TrackpadArrow) => keys.filter((x) => x === k).length;

    it('a drag to the edge sends a full line, either way', () => {
      expect(
        count(
          slide(
            [
              [0, 0],
              [180, 0],
            ],
            ACCEL,
          ).keys,
          'right',
        ),
      ).toBe(60);
      expect(
        count(
          slide(
            [
              [0, 0],
              [-180, 0],
            ],
            ACCEL,
          ).keys,
          'left',
        ),
      ).toBe(60);
    });

    it('near the press point it stays one column per step', () => {
      expect(
        slide(
          [
            [0, 0],
            [16, 0],
          ],
          ACCEL,
        ).keys,
      ).toEqual(['right', 'right']);
    });

    it('speeds up the farther the finger goes', () => {
      const first = count(
        slide(
          [
            [0, 0],
            [90, 0],
          ],
          ACCEL,
        ).keys,
        'right',
      );
      const second = 60 - first; // the outer half of the way to the edge
      expect(second).toBeGreaterThanOrEqual(first * 2);
    });

    it('each side is fitted to its own reach', () => {
      const offCentre: TrackpadConfig = { ...ACCEL, reach: { left: 60, right: 300 } };
      expect(
        count(
          slide(
            [
              [0, 0],
              [-60, 0],
            ],
            offCentre,
          ).keys,
          'left',
        ),
      ).toBe(60);
      expect(
        count(
          slide(
            [
              [0, 0],
              [300, 0],
            ],
            offCentre,
          ).keys,
          'right',
        ),
      ).toBe(60);
    });

    it('coming back to the press point retraces every arrow', () => {
      const r = slide(
        [
          [0, 0],
          [150, 0],
          [0, 0],
        ],
        ACCEL,
      );
      expect(count(r.keys, 'left')).toBe(count(r.keys, 'right'));
    });

    it('up and down stay linear', () => {
      expect(
        slide(
          [
            [0, 0],
            [0, 64],
          ],
          ACCEL,
        ).keys,
      ).toEqual(Array(4).fill('down'));
    });

    it('a short line never slows the steps below the linear pace', () => {
      const short: TrackpadConfig = { ...ACCEL, lineCols: 5 };
      expect(
        count(
          slide(
            [
              [0, 0],
              [80, 0],
            ],
            short,
          ).keys,
          'right',
        ),
      ).toBe(10);
    });
  });
});
