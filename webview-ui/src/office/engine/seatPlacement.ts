/**
 * Pure seat-placement helpers, extracted from OfficeState so they can be unit
 * tested without pulling the canvas/DOM-touching engine into the Node test
 * project (mirrors officeCanvasCursor.ts). Structural types keep this module
 * dependency-free — OfficeState's real Seat/Character satisfy them.
 */

export interface SeatLike {
  seatCol: number;
  seatRow: number;
  assigned: boolean;
}

export interface AnchorLike {
  seatId: string | null;
  tileCol: number;
  tileRow: number;
}

/**
 * The tile a teammate should cluster around: its lead's SEAT when the lead has
 * one, otherwise the lead's live tile. A lead is assigned its seat at creation
 * but may still be walking toward it when the teammate is placed; anchoring to
 * the stable seat (not the transient walking tile) keeps clustering deterministic
 * so a closer free seat can't open up once the lead lands. Returns undefined when
 * there is no anchor at all.
 */
export function anchorTile(
  anchor: AnchorLike | undefined,
  seats: ReadonlyMap<string, SeatLike>,
): { col: number; row: number } | undefined {
  if (!anchor) return undefined;
  const seat = anchor.seatId ? seats.get(anchor.seatId) : undefined;
  return seat
    ? { col: seat.seatCol, row: seat.seatRow }
    : { col: anchor.tileCol, row: anchor.tileRow };
}

/**
 * The seat a new helper (sub-agent) takes: the free seat nearest its parent's
 * seat — the clustering teammates get, so a helper works at the next desk
 * over instead of standing at its parent's. Null when the parent is unknown or
 * no seat is free (the helper then stays beside the parent).
 */
export function helperSeat(
  parent: AnchorLike | undefined,
  seats: ReadonlyMap<string, SeatLike>,
  prefer?: (uid: string) => boolean,
): string | null {
  const at = anchorTile(parent, seats);
  return at ? closestFreeSeat(seats, at.col, at.row, prefer) : null;
}

/**
 * Free seat closest (Manhattan) to a tile — seats teammates beside their lead.
 * With `prefer` (the living office's "is this a desk, not a room seat?"), the
 * closest preferred seat wins and any other seat is only the fallback.
 */
export function closestFreeSeat(
  seats: ReadonlyMap<string, SeatLike>,
  col: number,
  row: number,
  prefer?: (uid: string) => boolean,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  let bestPreferred = false;
  for (const [uid, seat] of seats) {
    if (seat.assigned) continue;
    const preferred = prefer ? prefer(uid) : false;
    if (bestPreferred && !preferred) continue;
    const d = Math.abs(seat.seatCol - col) + Math.abs(seat.seatRow - row);
    if (d < bestDist || (preferred && !bestPreferred)) {
      best = uid;
      bestDist = d;
      bestPreferred = preferred;
    }
  }
  return best;
}
