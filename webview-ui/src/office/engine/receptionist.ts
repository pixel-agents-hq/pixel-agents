/**
 * The receptionist (docs/office/DESIGN.md, F. Office life): a non-agent NPC
 * seated behind the RECEPTION_DESK in the Entrance who waves when an agent
 * walks in. Like the consent greeter she lives outside OfficeState's agent
 * map, so nothing that counts, seats, routes or hit-tests agents sees her.
 * Pure: where she sits, and her wave's frames.
 */

import {
  RECEPTION_DESK_TYPE_PREFIX,
  RECEPTIONIST_WAVE_FRAME_SEC,
  RECEPTIONIST_WAVE_SEC,
} from '../../constants.js';
import type { Seat } from '../types.js';
import { Direction } from '../types.js';
import type { FootprintOf } from '../zones.js';
import { toZoneLabel, ZoneLabel } from '../zones.js';

/** Where she is: a seat behind the desk, or a standing tile there. */
export interface ReceptionPost {
  col: number;
  row: number;
  facing: Direction;
  /** The chair she sits on (reserved for her), or null when she stands. */
  seatId: string | null;
}

export interface ReceptionInput {
  cols: number;
  rows: number;
  areaTiles?: ReadonlyArray<string | null>;
  furniture: ReadonlyArray<{ type: string; col: number; row: number }>;
  footprint: FootprintOf;
  seats: ReadonlyMap<string, Seat>;
  walkable: (col: number, row: number) => boolean;
}

const AHEAD: Record<Direction, { dc: number; dr: number }> = {
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

/**
 * Her post: the first RECEPTION_DESK in the Entrance Area, and the free seat
 * that faces it (the chair behind it); without one, the walkable tile behind
 * the desk's middle, facing out. Null without such a desk.
 */
export function receptionPost(input: ReceptionInput): ReceptionPost | null {
  const { cols, rows, areaTiles } = input;
  if (!areaTiles || areaTiles.length === 0) return null;
  const isEntrance = (col: number, row: number): boolean =>
    col >= 0 &&
    row >= 0 &&
    col < cols &&
    row < rows &&
    toZoneLabel(areaTiles[row * cols + col]) === ZoneLabel.ENTRANCE;
  for (const item of input.furniture) {
    if (!item.type.startsWith(RECEPTION_DESK_TYPE_PREFIX)) continue;
    const fp = input.footprint(item.type) ?? { w: 1, h: 1, bgRows: 0 };
    const covers = (col: number, row: number) =>
      col >= item.col && col < item.col + fp.w && row >= item.row && row < item.row + fp.h;
    let inEntrance = false;
    for (let dr = 0; dr < fp.h && !inEntrance; dr++) {
      for (let dc = 0; dc < fp.w && !inEntrance; dc++) {
        inEntrance = isEntrance(item.col + dc, item.row + dr);
      }
    }
    if (!inEntrance) continue;
    // A chair whose sitter faces the desk.
    for (const [uid, seat] of input.seats) {
      if (seat.assigned) continue;
      const { dc, dr } = AHEAD[seat.facingDir];
      if (covers(seat.seatCol + dc, seat.seatRow + dr)) {
        return { col: seat.seatCol, row: seat.seatRow, facing: seat.facingDir, seatId: uid };
      }
    }
    // No chair: stand behind the middle of it (its see-through top row, or above it).
    const col = item.col + Math.floor(fp.w / 2);
    const bg = fp.bgRows ?? 0;
    for (const row of [item.row + bg - 1, item.row - 1]) {
      if (row >= 0 && input.walkable(col, row)) {
        return { col, row, facing: Direction.DOWN, seatId: null };
      }
    }
  }
  return null;
}

/** The wave's frame `t` seconds after it began: 0 (arm up) and 1 (arm out,
 *  bobbing) alternating, null once it's over. */
export function waveFrame(t: number): 0 | 1 | null {
  if (t < 0 || t >= RECEPTIONIST_WAVE_SEC) return null;
  return (Math.floor(t / RECEPTIONIST_WAVE_FRAME_SEC) % 2) as 0 | 1;
}

/** The waving forearm and hand, in sprite px from the feet anchor, by frame:
 *  raised beside her head (her right hand, on the viewer's left as she faces
 *  out, clear of her hair), then swung out. The renderer outlines them. */
export function waveHandPixels(frame: 0 | 1): Array<{ dx: number; dy: number }> {
  const forearm =
    frame === 0
      ? [
          { dx: -8, dy: -11 },
          { dx: -9, dy: -12 },
          { dx: -9, dy: -13 },
          { dx: -9, dy: -14 },
        ]
      : [
          { dx: -8, dy: -11 },
          { dx: -9, dy: -12 },
          { dx: -10, dy: -13 },
          { dx: -11, dy: -14 },
        ];
  const hx = frame === 0 ? -10 : -12; // the hand: 2×2 at the top of the forearm
  const hand = [
    { dx: hx, dy: -16 },
    { dx: hx + 1, dy: -16 },
    { dx: hx, dy: -15 },
    { dx: hx + 1, dy: -15 },
  ];
  return [...forearm, ...hand];
}

/** The 1 px outline around a set of px (their 4-neighbours not in the set). */
export function outlinePixels(
  pixels: ReadonlyArray<{ dx: number; dy: number }>,
): Array<{ dx: number; dy: number }> {
  const inside = new Set(pixels.map((p) => `${p.dx},${p.dy}`));
  const out = new Map<string, { dx: number; dy: number }>();
  for (const p of pixels) {
    for (const [ox, oy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const k = `${p.dx + ox},${p.dy + oy}`;
      if (!inside.has(k)) out.set(k, { dx: p.dx + ox, dy: p.dy + oy });
    }
  }
  return [...out.values()];
}
