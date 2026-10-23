/**
 * Trouble on the desk (docs/office/DESIGN.md, phase D): runtime-only furniture,
 * never saved to the layout. A failing agent gets the office pack's FIRE_ICON
 * (its ON frames, animated) on its desk; three failures in a row swap it for the
 * ALARM_LAMP, blinking OFF/ON. The desk is the tile its seat faces. Pure: the
 * sprite lookup and the clock come in, FurnitureInstances go out.
 */

import {
  ALARM_LAMP_BLINK_SEC,
  FIRE_ICON_FRAME_SEC,
  TROUBLE_ICON_DESK_DROP_PX,
  TROUBLE_ICON_SIDE_PX,
} from '../constants.js';
import type { Direction, FurnitureInstance, Seat, SpriteData } from '../office/types.js';
import { Direction as Dir, TILE_SIZE } from '../office/types.js';
import type { TroubleState } from './signalStore.js';

export const FIRE_FRAMES = ['FIRE_ICON_ON_1', 'FIRE_ICON_ON_2'] as const;
export const ALARM_FRAMES = ['ALARM_LAMP_OFF', 'ALARM_LAMP_ON'] as const;

/** The tile a seat faces: where its desk is. */
export function deskTileFor(seat: Pick<Seat, 'seatCol' | 'seatRow' | 'facingDir'>): {
  col: number;
  row: number;
} {
  const step: Record<Direction, [number, number]> = {
    [Dir.UP]: [0, -1],
    [Dir.DOWN]: [0, 1],
    [Dir.LEFT]: [-1, 0],
    [Dir.RIGHT]: [1, 0],
  };
  const [dc, dr] = step[seat.facingDir];
  return { col: seat.seatCol + dc, row: seat.seatRow + dr };
}

/** The sprite type a trouble level shows at time `t` (seconds). */
export function troubleFrame(level: TroubleState['level'], t: number): string {
  if (level === 'alarm') return ALARM_FRAMES[Math.floor(t / ALARM_LAMP_BLINK_SEC) % 2];
  return FIRE_FRAMES[Math.floor(t / FIRE_ICON_FRAME_SEC) % 2];
}

export interface TroubleOffice {
  characters: ReadonlyMap<number, { seatId: string | null; isSubagent: boolean }>;
  seats: ReadonlyMap<string, Seat>;
}

/**
 * One FurnitureInstance per agent in trouble that has a seat, at its desk.
 * Agents whose sprites aren't loaded (no office pack) get none.
 */
export function troubleFurniture(
  office: TroubleOffice,
  trouble: ReadonlyMap<number, TroubleState>,
  spriteOf: (type: string) => SpriteData | undefined,
  t: number,
): FurnitureInstance[] {
  const out: FurnitureInstance[] = [];
  for (const [id, state] of trouble) {
    const ch = office.characters.get(id);
    if (!ch || ch.isSubagent || !ch.seatId) continue;
    const seat = office.seats.get(ch.seatId);
    if (!seat) continue;
    const sprite = spriteOf(troubleFrame(state.level, t));
    if (!sprite || sprite.length === 0) continue;
    const desk = deskTileFor(seat);
    const h = sprite.length;
    const w = sprite[0]?.length ?? TILE_SIZE;
    // Beside the middle of the desk tile (the monitor usually sits in the middle),
    // raised onto the desk top. Sorted in front of the desk: a desk above the seat
    // ends at the seat row, so just past that (still behind the seated character);
    // any other desk may be two rows deep.
    const side = seat.facingDir === Dir.LEFT ? -TROUBLE_ICON_SIDE_PX : TROUBLE_ICON_SIDE_PX;
    const above = seat.facingDir === Dir.UP;
    const deskBottomRow = above ? desk.row : desk.row + 1;
    // The desk top: low on a desk below the seat (its first row is the desk's
    // back), high on the bottom row of a desk above it.
    const bottom = (above ? desk.row : desk.row + 1) * TILE_SIZE + TROUBLE_ICON_DESK_DROP_PX;
    out.push({
      sprite,
      x: desk.col * TILE_SIZE + (TILE_SIZE - w) / 2 + side,
      y: bottom - h,
      zY: (deskBottomRow + 1) * TILE_SIZE + 0.5,
    });
  }
  return out;
}
