/**
 * Workstations: which seat works at which PC.
 *
 * Every electronics item belongs to at most one seat and every seat to at most
 * one item. A seat can only own an item when it faces a desk (the tile right in
 * front of it is a desk tile), the item stands on that desk within reach, and
 * the item's screen faces the seat (a back-facing chair works at a front-facing
 * PC, a side chair at a side PC). Contested items go to the closest seat.
 *
 * The seat picker uses this to prefer seats with a PC, and the renderer to turn
 * on only the PC of a seat whose agent is working there. DOM-free.
 */

import { AUTO_ON_FACING_DEPTH, AUTO_ON_SIDE_DEPTH } from '../../constants.js';
import type { PlacedFurniture, Seat } from '../types.js';
import { Direction } from '../types.js';

export interface WorkstationCatalogEntry {
  category?: string;
  isDesk?: boolean;
  footprintW: number;
  footprintH: number;
  orientation?: string;
}

export type WorkstationSeat = Pick<Seat, 'seatCol' | 'seatRow' | 'facingDir'>;

/** The direction a seat must face to look at an item's screen, by the item's
 *  orientation. Items without an orientation work from any side. */
const SEAT_FACING_FOR_ITEM: Record<string, Direction> = {
  front: Direction.UP,
  back: Direction.DOWN,
  side: Direction.RIGHT,
  right: Direction.RIGHT,
  left: Direction.LEFT,
};

function facingOffset(dir: Direction): { dCol: number; dRow: number } {
  if (dir === Direction.RIGHT) return { dCol: 1, dRow: 0 };
  if (dir === Direction.LEFT) return { dCol: -1, dRow: 0 };
  if (dir === Direction.DOWN) return { dCol: 0, dRow: 1 };
  return { dCol: 0, dRow: -1 };
}

const key = (col: number, row: number): string => `${col},${row}`;

/**
 * Tiles a seat can reach, with a distance score: straight ahead up to
 * AUTO_ON_FACING_DEPTH tiles, and one tile to either side up to
 * AUTO_ON_SIDE_DEPTH. Side tiles score half a step worse than the tile ahead
 * at the same depth, so an aligned item wins a tie.
 */
function reachableTiles(seat: WorkstationSeat): Map<string, number> {
  const { dCol, dRow } = facingOffset(seat.facingDir);
  const out = new Map<string, number>();
  for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
    out.set(key(seat.seatCol + dCol * d, seat.seatRow + dRow * d), d * 2);
  }
  for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
    const col = seat.seatCol + dCol * d;
    const row = seat.seatRow + dRow * d;
    for (const side of [-1, 1]) {
      const k = dCol !== 0 ? key(col, row + side) : key(col + side, row);
      if (!out.has(k)) out.set(k, d * 2 + 1);
    }
  }
  return out;
}

/** Map of seat uid → the uid of the electronics item that seat works at. */
export function pairWorkstations(
  seats: Map<string, WorkstationSeat>,
  furniture: PlacedFurniture[],
  lookup: (type: string) => WorkstationCatalogEntry | undefined,
): Map<string, string> {
  const deskTiles = new Set<string>();
  const electronics: Array<{ item: PlacedFurniture; entry: WorkstationCatalogEntry }> = [];
  for (const item of furniture) {
    const entry = lookup(item.type);
    if (!entry) continue;
    if (entry.isDesk) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          deskTiles.add(key(item.col + dc, item.row + dr));
        }
      }
    }
    if (entry.category === 'electronics') electronics.push({ item, entry });
  }

  const candidates: Array<{ seatUid: string; itemUid: string; score: number }> = [];
  for (const [seatUid, seat] of seats) {
    const { dCol, dRow } = facingOffset(seat.facingDir);
    if (!deskTiles.has(key(seat.seatCol + dCol, seat.seatRow + dRow))) continue;
    const reach = reachableTiles(seat);
    for (const { item, entry } of electronics) {
      const wanted = entry.orientation ? SEAT_FACING_FOR_ITEM[entry.orientation] : undefined;
      if (wanted !== undefined && wanted !== seat.facingDir) continue;
      let best = Infinity;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const k = key(item.col + dc, item.row + dr);
          const score = reach.get(k);
          // Only items standing on a desk tile count — not one across the aisle.
          if (score !== undefined && score < best && deskTiles.has(k)) best = score;
        }
      }
      if (best !== Infinity) candidates.push({ seatUid, itemUid: item.uid, score: best });
    }
  }

  // Closest pairs first; uids break ties so the result never depends on order.
  candidates.sort(
    (a, b) =>
      a.score - b.score || a.seatUid.localeCompare(b.seatUid) || a.itemUid.localeCompare(b.itemUid),
  );
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  for (const c of candidates) {
    if (pairs.has(c.seatUid) || taken.has(c.itemUid)) continue;
    pairs.set(c.seatUid, c.itemUid);
    taken.add(c.itemUid);
  }
  return pairs;
}
