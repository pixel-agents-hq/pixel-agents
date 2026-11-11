/**
 * Character sheet geometry: a 128x96 RGBA sheet of 24 frames (3 direction rows: down, up,
 * right x 8 frames: walk1-3, type1-2, read1-2, seated), each 16x32 pixels indexed y * 16 + x.
 */

import { currentSheetPixels } from '../../../core/src/assets/characterSheet.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHAR_SHEET_FRAMES,
  CHARACTER_DIRECTIONS,
  PNG_ALPHA_THRESHOLD,
} from '../../../core/src/assets/constants.js';
import { LEGACY_SHEET_W } from '../../../core/src/assets/seatedFrame.js';

export const SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
export const SHEET_H = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
/** Frames on a sheet (row * 8 + frame). */
export const FRAME_COUNT = CHAR_SHEET_FRAMES;

/** Whether an alpha value draws (lower ones are empty). */
export const isOpaque = (alpha: number) => alpha >= PNG_ALPHA_THRESHOLD;

/** Byte offset of pixel `i` (y * 16 + x) of sheet frame `ci` (row * 8 + frame). */
export const cellAt = (ci: number, i: number) =>
  ((Math.floor(ci / CHAR_FRAMES_PER_ROW) * CHAR_FRAME_H + Math.floor(i / CHAR_FRAME_W)) * SHEET_W +
    (ci % CHAR_FRAMES_PER_ROW) * CHAR_FRAME_W +
    (i % CHAR_FRAME_W)) *
  4;

/**
 * A decoded image's pixels as a sheet: as they are at the sheet's size, widened with the
 * seated frame when it is a sheet from before it (112x96); null when it is neither.
 */
export function decodeSheet(img: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): Uint8ClampedArray | null {
  if (img.height !== SHEET_H || (img.width !== SHEET_W && img.width !== LEGACY_SHEET_W)) {
    return null;
  }
  return currentSheetPixels(img.width, img.data).data;
}
