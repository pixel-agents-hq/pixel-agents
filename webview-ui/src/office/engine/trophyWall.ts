/**
 * Living office, phase B: the trophy wall. Today's PRs and pushes stand on the
 * Lounge bookshelves, one trophy per shelf: cups for PRs (gold, silver,
 * bronze, cycling), then a box per push, up to the number of shelves.
 *
 * Trophies are runtime-only furniture: derived from the layout and the day's
 * tally on every furniture rebuild, never written into the layout. Each one
 * is listed right after its bookshelf, so on the equal depth (same bottom
 * edge) the stable z-sort draws it on top of the shelf.
 *
 * Pure and DOM-free, with the catalog injected (`footprint`) like zones.ts.
 */

import {
  TROPHY_BOX_TYPE,
  TROPHY_CUP_TYPES,
  TROPHY_SHELF_TYPE,
  TROPHY_SLOT_DCOL,
  TROPHY_SLOT_DROW,
} from '../../constants.js';
import type { PlacedFurniture } from '../types.js';
import type { FootprintOf } from '../zones.js';
import { toZoneLabel, ZoneLabel } from '../zones.js';

export interface TrophyLayoutInput {
  cols: number;
  rows: number;
  furniture: PlacedFurniture[];
  areaTiles?: Array<string | null>;
}

/** uid prefix of trophy furniture (runtime-only; never in a saved layout). */
export const TROPHY_UID_PREFIX = 'trophy:';

/**
 * The Area a shelf belongs to. Bookshelves hang on the wall, and wall tiles
 * usually carry no Area, so a shelf without a labelled footprint tile takes
 * the label of the floor right below it.
 */
function shelfArea(
  item: PlacedFurniture,
  w: number,
  h: number,
  input: TrophyLayoutInput,
): string | null {
  const { cols, rows, areaTiles } = input;
  if (!areaTiles || areaTiles.length === 0) return null;
  const at = (col: number, row: number): string | null =>
    col < 0 || row < 0 || col >= cols || row >= rows ? null : (areaTiles[row * cols + col] ?? null);
  for (let dr = 0; dr <= h; dr++) {
    for (let dc = 0; dc < w; dc++) {
      const label = at(item.col + dc, item.row + dr);
      if (label) return label;
    }
  }
  return null;
}

/**
 * The trophy shelves, left to right: the bookshelves in the Lounge, or every
 * bookshelf when the layout has no Lounge.
 */
export function trophyShelves(input: TrophyLayoutInput, footprint: FootprintOf): PlacedFurniture[] {
  const shelves = input.furniture.filter((f) => f.type === TROPHY_SHELF_TYPE);
  const hasLounge = (input.areaTiles ?? []).some((l) => toZoneLabel(l) === ZoneLabel.LOUNGE);
  const picked = hasLounge
    ? shelves.filter((f) => {
        const fp = footprint(f.type);
        return fp && toZoneLabel(shelfArea(f, fp.w, fp.h, input)) === ZoneLabel.LOUNGE;
      })
    : shelves;
  return [...picked].sort((a, b) => a.col - b.col || a.row - b.row);
}

/** The trophies to show, in shelf order: a cup per PR, then a box per push, capped. */
export function trophyTypes(prCount: number, pushCount: number, slots: number): string[] {
  const types: string[] = [];
  for (let i = 0; i < prCount && types.length < slots; i++) {
    types.push(TROPHY_CUP_TYPES[i % TROPHY_CUP_TYPES.length]);
  }
  for (let i = 0; i < pushCount && types.length < slots; i++) types.push(TROPHY_BOX_TYPE);
  return types;
}

/**
 * `furniture` with today's trophies inserted, each right after its shelf
 * (so it draws over it). Returns the input array itself when there are none.
 */
export function withTrophies(
  input: TrophyLayoutInput,
  footprint: FootprintOf,
  prCount: number,
  pushCount: number,
): PlacedFurniture[] {
  if (prCount <= 0 && pushCount <= 0) return input.furniture;
  const shelves = trophyShelves(input, footprint);
  const types = trophyTypes(prCount, pushCount, shelves.length);
  if (types.length === 0) return input.furniture;
  const trophyFor = new Map<string, PlacedFurniture>();
  types.forEach((type, i) => {
    const shelf = shelves[i];
    trophyFor.set(shelf.uid, {
      uid: `${TROPHY_UID_PREFIX}${shelf.uid}`,
      type,
      col: shelf.col + TROPHY_SLOT_DCOL,
      row: shelf.row + TROPHY_SLOT_DROW,
    });
  });
  const out: PlacedFurniture[] = [];
  for (const item of input.furniture) {
    out.push(item);
    const trophy = trophyFor.get(item.uid);
    if (trophy) out.push(trophy);
  }
  return out;
}
