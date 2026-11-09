import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { decodeCharacterPng } from '../../core/src/assets/pngDecoder.js';
import { LEGACY_SHEET_W, SEATED_FRAME } from '../../core/src/assets/seatedFrame.js';

/** A legacy 112x96 sheet whose pixel (x, y) of frame f in row r is coloured by r, f and x. */
function legacySheet(): Buffer {
  const png = new PNG({ width: LEGACY_SHEET_W, height: 96 });
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < LEGACY_SHEET_W; x++) {
      const i = (y * LEGACY_SHEET_W + x) * 4;
      png.data[i] = Math.floor(y / 32) * 50; // row
      png.data[i + 1] = Math.floor(x / 16) * 30; // frame
      png.data[i + 2] = (x % 16) * 10; // column in the frame
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const hex = (row: number, frame: number, x: number) =>
  '#' +
  [row * 50, frame * 30, x * 10]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

describe('the seated frame', () => {
  it('a legacy char_N.png decodes with its seated frame derived from the typing frames', () => {
    const sprites = decodeCharacterPng(legacySheet());
    for (const [row, dir] of (['down', 'up', 'right'] as const).entries()) {
      const frames = sprites[dir];
      expect(frames).toHaveLength(SEATED_FRAME + 1);
      expect(frames[5][0][3]).toBe(hex(row, 5, 3)); // the old frames stay where they were
      const seated = frames[SEATED_FRAME][0];
      if (dir === 'right') {
        // the side view is type1 throughout
        expect(seated).toEqual(frames[3][0]);
      } else {
        // front and back: the left half from type2, the right half from type1
        expect(seated.slice(0, 8)).toEqual(frames[4][0].slice(0, 8));
        expect(seated.slice(8)).toEqual(frames[3][0].slice(8));
      }
    }
  });
});
