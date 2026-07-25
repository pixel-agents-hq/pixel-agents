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

/** Free seat closest (Manhattan) to a tile — seats teammates beside their lead. */
export function closestFreeSeat(
  seats: ReadonlyMap<string, SeatLike>,
  col: number,
  row: number,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [uid, seat] of seats) {
    if (seat.assigned) continue;
    const d = Math.abs(seat.seatCol - col) + Math.abs(seat.seatRow - row);
    if (d < bestDist) {
      best = uid;
      bestDist = d;
    }
  }
  return best;
}
