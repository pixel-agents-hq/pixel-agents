/**
 * A character's preview: its standing frame facing down, up and right, side by side on a
 * transparent background, each sheet pixel drawn as a `scale`x`scale` block (whole pixels,
 * so the pixel art stays crisp). Pure: the caller encodes it (the server, as a PNG).
 */

import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
} from '../assets/constants.js';
import { SHEET_FRAMES } from '../assets/seatedFrame.js';
import { cellAt } from './sheet.js';
import type { Rgba } from './wardrobe.js';

/** The frame a character stands in (walk2, between the steps), as the office draws it idle. */
const STANDING = SHEET_FRAMES.walk[1];

/** The preview of a 128x96 sheet (see the module comment); throws on a scale that isn't a whole number ≥ 1. */
export function previewPixels(sheet: Uint8ClampedArray, scale: number): Rgba {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`[Wardrobe] preview scale must be a whole number ≥ 1, not ${scale}`);
  }
  const frameW = CHAR_FRAME_W * scale;
  const width = frameW * CHARACTER_DIRECTIONS.length;
  const height = CHAR_FRAME_H * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  CHARACTER_DIRECTIONS.forEach((_, row) => {
    const frame = row * CHAR_FRAMES_PER_ROW + STANDING;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < frameW; x++) {
        const src = cellAt(frame, Math.floor(y / scale) * CHAR_FRAME_W + Math.floor(x / scale));
        data.set(sheet.subarray(src, src + 4), (y * width + row * frameW + x) * 4);
      }
    }
  });
  return { width, height, data };
}
