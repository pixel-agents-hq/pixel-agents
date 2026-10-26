import { describe, expect, it } from 'vitest';

import { gridRuns, litBox } from '../src/components/ui/pixelGrid.js';

describe('gridRuns', () => {
  it('merges each row’s lit pixels into runs, row by row', () => {
    expect(gridRuns(['##.#', '....', '.###'])).toEqual([
      [0, 0, 2],
      [3, 0, 1],
      [1, 2, 3],
    ]);
  });

  it('shifts every run right by x0', () => {
    expect(gridRuns(['.#'], 5)).toEqual([[6, 0, 1]]);
  });

  it('closes a run at the end of a row', () => {
    expect(gridRuns(['..##'])).toEqual([[2, 0, 2]]);
  });
});

describe('litBox', () => {
  it('bounds the lit pixels, not the grid', () => {
    expect(litBox(['....', '.#..', '..#.', '....'])).toEqual({
      minX: 1,
      maxX: 2,
      minY: 1,
      maxY: 2,
    });
  });

  it('is empty for an unlit grid', () => {
    const box = litBox(['..', '..']);
    expect(box.minX > box.maxX && box.minY > box.maxY).toBe(true);
  });
});
