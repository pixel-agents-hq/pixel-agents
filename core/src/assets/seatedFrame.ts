/**
 * The seated idle frame: a character sitting in its chair with nothing to do (sheet column 7,
 * after walk1-3, type1-2, read1-2). It is derived from the two typing frames, one recipe for
 * every piece of art and every pixel edit, so worn pieces always line up:
 *
 * - front and back: each half from the typing frame whose arm on that side is forward (the
 *   hand drawn in over the body, not hanging at the side): the left half from type2, the
 *   right half from type1. The typing frames mirror each other, so the pose is symmetric.
 * - side: type1, whose arm sits lower.
 *
 * Sheets made before the column existed are 7 frames wide (112x96); `widenLegacySheet` and
 * `widenLegacyCells` bring them and pixel edits made on them up to the current layout.
 */

import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
} from './constants.js';

/** The seated idle frame's column in a sheet row. */
export const SEATED_FRAME = 7;
/** Each animation's frames, as columns of a sheet row: the walk cycle (walk2 between
 *  the steps), typing, reading, and the seated frame. */
export const SHEET_FRAMES = {
  walk: [0, 1, 2, 1],
  type: [3, 4],
  read: [5, 6],
  seated: SEATED_FRAME,
} as const;
/** The typing frames' columns (type1, type2). */
const [TYPE1, TYPE2] = SHEET_FRAMES.type;
/** Frames per row of a sheet made before the seated frame (112 pixels wide). */
export const LEGACY_FRAMES_PER_ROW = 7;
/** A legacy sheet's width. */
export const LEGACY_SHEET_W = CHAR_FRAME_W * LEGACY_FRAMES_PER_ROW;

/** The typing frame column pixel column `x` of a row's seated frame is copied from. */
export function seatedSource(row: number, x: number): number {
  if (CHARACTER_DIRECTIONS[row] === 'right') return TYPE1;
  return x < CHAR_FRAME_W / 2 ? TYPE2 : TYPE1;
}

/**
 * Fill a sheet's seated column from its typing frames (in place). `width` is the sheet's
 * width in pixels, which must hold the seated column.
 */
export function deriveSeatedColumn(data: Uint8Array | Uint8ClampedArray, width: number): void {
  for (let row = 0; row < CHARACTER_DIRECTIONS.length; row++) {
    for (let y = 0; y < CHAR_FRAME_H; y++) {
      const line = (row * CHAR_FRAME_H + y) * width;
      for (let x = 0; x < CHAR_FRAME_W; x++) {
        const from = (line + seatedSource(row, x) * CHAR_FRAME_W + x) * 4;
        const to = (line + SEATED_FRAME * CHAR_FRAME_W + x) * 4;
        data.copyWithin(to, from, from + 4);
      }
    }
  }
}

/** A legacy 7-frame RGBA sheet (112 wide) in the current layout, its seated column derived. */
export function widenLegacySheet(src: Uint8Array | Uint8ClampedArray): Uint8ClampedArray {
  const width = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
  const height = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(src.subarray(y * LEGACY_SHEET_W * 4, (y + 1) * LEGACY_SHEET_W * 4), y * width * 4);
  }
  deriveSeatedColumn(out, width);
  return out;
}

/**
 * Pixel edit cells keyed by legacy frame (row * 7 + frame) rekeyed for the current sheet
 * (row * 8 + frame), with the seated frame's cells derived from the typing frames' the
 * way its art is, so an edit shows in every frame it showed in before.
 */
export function widenLegacyCells<V>(
  cells: Record<string, Record<string, V>>,
): Record<string, Record<string, V>> {
  const out: Record<string, Record<string, V>> = {};
  for (const [key, pixels] of Object.entries(cells)) {
    const f = Number(key);
    const row = Math.floor(f / LEGACY_FRAMES_PER_ROW);
    if (row >= CHARACTER_DIRECTIONS.length) continue; // past a legacy sheet: drawn nowhere
    out[row * CHAR_FRAMES_PER_ROW + (f % LEGACY_FRAMES_PER_ROW)] = pixels;
  }
  for (let row = 0; row < CHARACTER_DIRECTIONS.length; row++) {
    const seated: Record<string, V> = {};
    for (const source of [TYPE1, TYPE2]) {
      const pixels = cells[row * LEGACY_FRAMES_PER_ROW + source];
      if (!pixels) continue;
      for (const [i, v] of Object.entries(pixels)) {
        if (seatedSource(row, Number(i) % CHAR_FRAME_W) === source) seated[i] = v;
      }
    }
    if (Object.keys(seated).length) out[row * CHAR_FRAMES_PER_ROW + SEATED_FRAME] = seated;
  }
  return out;
}
