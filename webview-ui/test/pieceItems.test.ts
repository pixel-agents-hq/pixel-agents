import { describe, expect, it } from 'vitest';

import { rgbHex } from '../src/characters/color.js';
import { editsFromSheet } from '../src/characters/items.js';
import { cellAt, SHEET_H, SHEET_W } from '../src/characters/sheet.js';

const blank = () => new Uint8ClampedArray(SHEET_W * SHEET_H * 4);
const paint = (d: Uint8ClampedArray, frame: number, pixel: number, rgb: number[]) =>
  d.set([...rgb, 255], cellAt(frame, pixel));

describe('editsFromSheet', () => {
  it('records only the pixels that differ: painted, recoloured or erased', () => {
    const base = blank();
    paint(base, 0, 5, [10, 20, 30]); // kept
    paint(base, 3, 7, [10, 20, 30]); // erased
    paint(base, 20, 9, [10, 20, 30]); // recoloured
    const sheet = blank();
    paint(sheet, 0, 5, [10, 20, 30]);
    paint(sheet, 20, 9, [255, 0, 0]);
    paint(sheet, 1, 0, [0, 0, 0]); // new
    expect(editsFromSheet(base, sheet)).toEqual({
      cells: { 1: { 0: rgbHex(0, 0, 0) }, 3: { 7: null }, 20: { 9: rgbHex(255, 0, 0) } },
    });
  });

  it('the same sheet makes no edits', () => {
    const base = blank();
    paint(base, 4, 100, [1, 2, 3]);
    expect(editsFromSheet(base, new Uint8ClampedArray(base))).toEqual({ cells: {} });
  });
});
