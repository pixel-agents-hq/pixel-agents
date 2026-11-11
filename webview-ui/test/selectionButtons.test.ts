import { describe, expect, it } from 'vitest';

import {
  buttonGeometry,
  placeSelectionButtons,
  restingBounds,
  selectionButtonAt,
} from '../src/office/engine/selectionButtons.js';
import { TILE_SIZE } from '../src/office/types.js';

describe('buttonGeometry', () => {
  it('is an 8-row icon plus padding on each side', () => {
    const { unit, pad, size } = buttonGeometry(2);
    expect(size).toBe(8 * unit + 2 * pad);
  });
});

describe('selectionButtonAt', () => {
  const rotate = { cx: 10, cy: 10, half: 5 };
  const del = { cx: 30, cy: 10, half: 5 };

  it('finds the button under the point, with 2 px of slack', () => {
    expect(selectionButtonAt({ rotate, delete: del }, 10, 10)).toBe('rotate');
    expect(selectionButtonAt({ rotate, delete: del }, 37, 17)).toBe('delete');
    expect(selectionButtonAt({ rotate, delete: del }, 38, 10)).toBeNull();
    expect(selectionButtonAt({ rotate, delete: del }, 20, 10)).toBeNull();
  });

  it('checks rotate first where they overlap', () => {
    expect(selectionButtonAt({ rotate, delete: { ...rotate } }, 10, 10)).toBe('rotate');
  });

  it('misses a button that is not drawn', () => {
    expect(selectionButtonAt({ rotate: null, delete: del }, 10, 10)).toBeNull();
    expect(selectionButtonAt({ rotate: null, delete: null }, 30, 10)).toBeNull();
  });
});

describe('placeSelectionButtons', () => {
  const geometry = { unit: 2, pad: 4, size: 24, shadow: 2, gap: 6 };
  const item = { col: 4, row: 4, w: 2, h: 1, offsetX: 0, offsetY: 0, zoom: 1, rotatable: true };

  it('puts them above the item, flush with its right edge, rotate left of delete', () => {
    const { delete: del, rotate } = placeSelectionButtons(item, geometry);
    const right = 6 * TILE_SIZE;
    expect(del).toEqual({ x: right - 24, y: 4 * TILE_SIZE - 6 - 24 });
    expect(rotate).toEqual({ x: right - 48 - 6, y: del.y });
  });

  it('puts them below an item at the top of the screen', () => {
    const { delete: del } = placeSelectionButtons({ ...item, row: 0 }, geometry);
    expect(del.y).toBe(TILE_SIZE + 6);
  });

  it('keeps the row inside the left edge, and has no rotate for a fixed item', () => {
    const { delete: del, rotate } = placeSelectionButtons(
      { ...item, col: 0, w: 1, rotatable: false },
      geometry,
    );
    expect(rotate).toBeNull();
    expect(del.x).toBe(Math.max(TILE_SIZE, 24 + 6) - 24);
  });
});

describe('restingBounds', () => {
  it('centres on the whole-pixel square', () => {
    const geometry = { unit: 2, pad: 4, size: 24, shadow: 2, gap: 6 };
    expect(restingBounds(10.4, 19.6, geometry)).toEqual({ cx: 22, cy: 32, half: 12 });
  });
});
