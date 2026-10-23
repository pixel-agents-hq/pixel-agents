/**
 * Name plates (docs/office/DESIGN.md, Ambience): a small brass plate on each
 * occupied desk in the Dev room with the agent's repo, in a 3×5 pixel font.
 * Runtime-only furniture — never in the layout, so never saved — placed at
 * the front edge of the desk in front of the agent's seat, and gone the
 * moment the seat frees. Pure: the font, the fit, and where a plate goes.
 */

import {
  NAME_PLATE_DESK_FRONT_INSET_PX,
  NAME_PLATE_FACE,
  NAME_PLATE_SPRITE_BOTTOM_PX,
} from '../../constants.js';
import type { Seat } from '../types.js';
import { Direction, TILE_SIZE } from '../types.js';

/** 3×5 glyphs, `#` lit. Upper case only: the plate shows the repo in caps. */
const FONT: Record<string, readonly string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '-': ['...', '...', '###', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
  '.': ['...', '...', '...', '...', '.#.'],
  ' ': ['...', '...', '...', '...', '...'],
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
/** Glyph width plus the 1 px gap after it. */
const ADVANCE = GLYPH_W + 1;

/**
 * The plate's text: the repo in caps, cut to `maxChars`. Characters the font
 * lacks become `-` (separators in repo names: `my.repo` and `my_repo` keep
 * theirs). Empty when there is no repo or no room.
 */
export function plateText(repo: string | undefined, maxChars: number): string {
  if (!repo || maxChars <= 0) return '';
  let out = '';
  for (const ch of repo.trim().toUpperCase()) {
    if (out.length >= maxChars) break;
    out += ch in FONT ? ch : '-';
  }
  return out;
}

/**
 * How the text fits the plate's face at a zoom: each font px is `px` device
 * px — as large as fits the face's height, at least 1 — and `maxChars` fit
 * its width. At zoom 2 that's 5 characters of 1 px, at zoom 4, 10.
 */
export function plateTextFit(zoom: number): { px: number; maxChars: number } {
  const px = Math.max(1, Math.floor((NAME_PLATE_FACE.h * zoom) / GLYPH_H));
  const maxChars = Math.floor((NAME_PLATE_FACE.w * zoom + 1 * px) / (ADVANCE * px));
  return { px, maxChars };
}

/** The lit px of a text, in font px from its top-left, and its width. */
export function plateTextPixels(text: string): {
  pixels: Array<{ x: number; y: number }>;
  width: number;
} {
  const pixels: Array<{ x: number; y: number }> = [];
  [...text].forEach((ch, i) => {
    const glyph = FONT[ch] ?? FONT['-'];
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (glyph[y][x] === '#') pixels.push({ x: i * ADVANCE + x, y });
      }
    }
  });
  const width = text.length > 0 ? text.length * ADVANCE - 1 : 0;
  return { pixels, width };
}

/** A desk on the floor: its footprint and sprite height (catalog). */
export interface DeskFootprint {
  col: number;
  row: number;
  w: number;
  h: number;
  spriteH: number;
}

const FACING: Record<Direction, { dc: number; dr: number }> = {
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

const covers = (d: DeskFootprint, col: number, row: number): boolean =>
  col >= d.col && col < d.col + d.w && row >= d.row && row < d.row + d.h;

/** The desk in front of a seat: the one under the tile it faces (or the next). */
export function deskInFront(
  seat: Pick<Seat, 'seatCol' | 'seatRow' | 'facingDir'>,
  desks: readonly DeskFootprint[],
): DeskFootprint | null {
  const { dc, dr } = FACING[seat.facingDir];
  for (let d = 1; d <= 2; d++) {
    const col = seat.seatCol + dc * d;
    const row = seat.seatRow + dr * d;
    const desk = desks.find((k) => covers(k, col, row));
    if (desk) return desk;
  }
  return null;
}

/**
 * Where a seat's plate goes, in world px (the plate sprite's top-left), and
 * its depth: on the desk in front of the seat, beside the seat's column (the
 * computer is in front of the seat), its bottom on the desk's front edge.
 * Sideways seats (a side desk) get it on the desk tile they face, by the
 * seat's row. Null without a desk in front.
 */
export function namePlatePlacement(
  seat: Pick<Seat, 'seatCol' | 'seatRow' | 'facingDir'>,
  desks: readonly DeskFootprint[],
): { x: number; y: number; zY: number } | null {
  const desk = deskInFront(seat, desks);
  if (!desk) return null;
  const deskZY = desk.row * TILE_SIZE + desk.spriteH;
  const zY = deskZY + 0.5; // in front of the desk it stands on
  if (seat.facingDir === Direction.UP || seat.facingDir === Direction.DOWN) {
    const inside = (col: number) => col >= desk.col && col < desk.col + desk.w;
    const col = inside(seat.seatCol + 1)
      ? seat.seatCol + 1
      : inside(seat.seatCol - 1)
        ? seat.seatCol - 1
        : seat.seatCol;
    const bottom = deskZY - NAME_PLATE_DESK_FRONT_INSET_PX;
    return { x: col * TILE_SIZE, y: bottom - NAME_PLATE_SPRITE_BOTTOM_PX, zY };
  }
  const col = seat.seatCol + FACING[seat.facingDir].dc;
  const bottom = (seat.seatRow + 1) * TILE_SIZE - 2;
  return { x: col * TILE_SIZE, y: bottom - NAME_PLATE_SPRITE_BOTTOM_PX, zY };
}
