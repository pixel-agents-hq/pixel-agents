/**
 * Phase M (docs/office/DESIGN.md): Ansh's private office and the Manager's
 * desk outside it, read from the layout's `Ansh` and `Manager` Areas.
 *
 * Pure and DOM-free (walkability and the zone of a tile are injected), so it
 * unit-tests in the Node runner. A layout without these Areas yields no knock
 * spots and no NPC places: permission requests keep going to the Meeting room
 * and neither NPC appears.
 */

import type { Seat } from './types.js';
import { Direction } from './types.js';

/** A place to stand (or sit) and the way to face once there. */
export interface StandPlace {
  col: number;
  row: number;
  facing: Direction;
}

/** A knock spot, shaped like zones.ts's ZonePlace (kept structural to avoid an import cycle). */
export interface KnockSpot<Z extends string> {
  zone: Z;
  key: string;
  col: number;
  row: number;
  facing: Direction;
  sit: false;
}

type TileTest = (col: number, row: number) => boolean;

/** From a neighbour of a tile, the way back to that tile. */
const NEIGHBOURS: ReadonlyArray<{ dc: number; dr: number; facing: Direction }> = [
  { dc: 0, dr: 1, facing: Direction.UP }, // below it
  { dc: -1, dr: 0, facing: Direction.RIGHT }, // left of it
  { dc: 1, dr: 0, facing: Direction.LEFT }, // right of it
  { dc: 0, dr: -1, facing: Direction.DOWN }, // above it
];

/** One step the other way from a facing (further out from the door). */
const STEP_BACK: Record<Direction, { dc: number; dr: number }> = {
  [Direction.UP]: { dc: 0, dr: 1 },
  [Direction.DOWN]: { dc: 0, dr: -1 },
  [Direction.LEFT]: { dc: 1, dr: 0 },
  [Direction.RIGHT]: { dc: -1, dr: 0 },
};

/** Sideways from a facing: the two directions along the wall it faces. */
const SIDEWAYS: Record<Direction, Array<{ dc: number; dr: number }>> = {
  [Direction.UP]: [
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ],
  [Direction.DOWN]: [
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ],
  [Direction.LEFT]: [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
  ],
  [Direction.RIGHT]: [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
  ],
};

/**
 * Where an agent with a permission request knocks: the walkable tiles just
 * outside the room's door, facing in. A door is where a walkable room tile
 * meets a walkable tile outside it. When that outside tile is the gap in the
 * wall itself — unlabeled doorway tiles, with the wall reached sideways
 * along the room's edge within `maxDoorWidth` tiles — the spot is the tile
 * beyond it, so the knocker stands in front of the door, not in it. Then a
 * second rank one step further out, facing the same way, so a small queue
 * forms before the request overflows to Meeting. Ordered front rank first:
 * the router takes them in this order.
 */
export function knockSpots<Z extends string>(
  zone: Z,
  roomTiles: ReadonlyArray<{ col: number; row: number }>,
  inRoom: TileTest,
  walkable: TileTest,
  /** A wall (or void) tile. Without it, no doorway gap is stepped over. */
  isWall: TileTest = () => false,
  maxDoorWidth = 4,
): Array<KnockSpot<Z>> {
  const spot = (col: number, row: number, facing: Direction): KnockSpot<Z> => ({
    zone,
    key: `spot:${col},${row}`,
    col,
    row,
    facing,
    sit: false,
  });
  /** An outside tile in the wall line: walking along the room's edge (each
   *  step still beside a room tile) reaches a wall within maxDoorWidth. */
  const inDoorway = (
    col: number,
    row: number,
    out: { dc: number; dr: number },
    facing: Direction,
  ) =>
    SIDEWAYS[facing].some((d) => {
      for (let k = 1; k <= maxDoorWidth; k++) {
        const c = col + d.dc * k;
        const r = row + d.dr * k;
        if (isWall(c, r)) return true;
        if (!walkable(c, r) || !inRoom(c - out.dc, r - out.dr)) return false;
      }
      return false;
    });

  const gaps = new Set<string>();
  const taken = new Set<string>();
  const first: Array<KnockSpot<Z>> = [];
  for (const t of roomTiles) {
    if (!walkable(t.col, t.row)) continue;
    for (const n of NEIGHBOURS) {
      let col = t.col + n.dc;
      let row = t.row + n.dr;
      if (inRoom(col, row) || !walkable(col, row)) continue;
      if (inDoorway(col, row, n, n.facing)) {
        const beyondCol = col + n.dc;
        const beyondRow = row + n.dr;
        if (!walkable(beyondCol, beyondRow) || inRoom(beyondCol, beyondRow)) continue;
        gaps.add(`${col},${row}`); // the gap itself is never a spot
        col = beyondCol;
        row = beyondRow;
      }
      const k = `${col},${row}`;
      if (taken.has(k)) continue;
      taken.add(k);
      first.push(spot(col, row, n.facing));
    }
  }
  const second: Array<KnockSpot<Z>> = [];
  for (const s of first) {
    const back = STEP_BACK[s.facing];
    const col = s.col + back.dc;
    const row = s.row + back.dr;
    const k = `${col},${row}`;
    if (taken.has(k) || gaps.has(k) || inRoom(col, row) || !walkable(col, row)) continue;
    taken.add(k);
    second.push(spot(col, row, s.facing));
  }
  // A front-rank spot can't be another door's gap (a corner door, say).
  return [...first.filter((s) => !gaps.has(`${s.col},${s.row}`)), ...second];
}

export interface NpcPlacesInput {
  seats: ReadonlyMap<string, Seat>;
  /** Tiles of the `Ansh` Area and of the `Manager` Area. */
  anshTiles: ReadonlyArray<{ col: number; row: number }>;
  managerTiles: ReadonlyArray<{ col: number; row: number }>;
  walkable: TileTest;
  /** Under furniture (a desk's walkable back row, say): never a place to stand. */
  underFurniture?: TileTest;
  /** Seats facing a PC or monitor are preferred (a desk, not a sofa). */
  facesElectronics?: (seat: Seat) => boolean;
}

export interface NpcPlaces {
  /** Ansh's seat: a seat in the Ansh Area. */
  anshSeat: Seat | null;
  /** The Manager's seat: in the Manager Area, else beside it (never in Ansh's room). */
  managerSeat: Seat | null;
  /** No seat for the Manager: where it stands instead (a walkable Manager tile). */
  managerStand: StandPlace | null;
  /** Where the Manager stands by Ansh's desk on a report visit. */
  visitSpot: StandPlace | null;
  /** Every seat in the Ansh and Manager Areas (and the Manager's, if beside
   *  it): held for the NPCs, never handed to an agent. */
  heldSeatIds: string[];
}

export const NO_NPC_PLACES: NpcPlaces = {
  anshSeat: null,
  managerSeat: null,
  managerStand: null,
  visitSpot: null,
  heldSeatIds: [],
};

const tileKey = (col: number, row: number) => `${col},${row}`;

/** How far ahead of Ansh's seat to look for the far side of the desk. */
const VISIT_LOOK_AHEAD_TILES = 4;

/** One step straight ahead of a seat facing this way. */
const SEAT_AHEAD: Record<Direction, { dc: number; dr: number }> = {
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

/** The direction from one tile toward another, along the longer axis. */
export function facingToward(
  from: { col: number; row: number },
  to: { col: number; row: number },
): Direction {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (Math.abs(dc) > Math.abs(dr)) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr < 0 ? Direction.UP : Direction.DOWN;
}

/** Desk-like seats first, then layout order. */
function pickSeat(candidates: Seat[], facesElectronics?: (seat: Seat) => boolean): Seat | null {
  if (candidates.length === 0) return null;
  if (facesElectronics) {
    const desk = candidates.find((s) => facesElectronics(s));
    if (desk) return desk;
  }
  return candidates[0];
}

/** Where the NPCs sit and where the Manager stands on a visit. */
export function findNpcPlaces(input: NpcPlacesInput): NpcPlaces {
  const { seats, anshTiles, managerTiles } = input;
  const under = input.underFurniture ?? (() => false);
  const walkable: TileTest = (c, r) => input.walkable(c, r) && !under(c, r);
  const ansh = new Set(anshTiles.map((t) => tileKey(t.col, t.row)));
  const manager = new Set(managerTiles.map((t) => tileKey(t.col, t.row)));
  const all = [...seats.values()];

  const anshSeat =
    ansh.size > 0
      ? pickSeat(
          all.filter((s) => ansh.has(tileKey(s.seatCol, s.seatRow))),
          input.facesElectronics,
        )
      : null;

  let managerSeat: Seat | null = null;
  let managerStand: StandPlace | null = null;
  if (manager.size > 0) {
    managerSeat = pickSeat(
      all.filter((s) => manager.has(tileKey(s.seatCol, s.seatRow))),
      input.facesElectronics,
    );
    if (!managerSeat) {
      // A seat beside the Manager Area (not in Ansh's room, not Ansh's own).
      const beside = all.filter((s) => {
        if (s === anshSeat || ansh.has(tileKey(s.seatCol, s.seatRow))) return false;
        return [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ].some(([dc, dr]) => manager.has(tileKey(s.seatCol + dc, s.seatRow + dr)));
      });
      managerSeat = pickSeat(beside, input.facesElectronics);
    }
    if (!managerSeat) {
      const tile = managerTiles.find((t) => walkable(t.col, t.row));
      if (tile) managerStand = { col: tile.col, row: tile.row, facing: Direction.DOWN };
    }
  }

  // The visit spot: across the desk from Ansh — the first walkable room tile
  // straight ahead of the seat, past the desk — facing back at it. Else the
  // walkable room tile nearest the seat; without a seat, any room tile.
  let visitSpot: StandPlace | null = null;
  if (anshSeat && (managerSeat || managerStand)) {
    const ahead = SEAT_AHEAD[anshSeat.facingDir];
    for (let d = 1; d <= VISIT_LOOK_AHEAD_TILES; d++) {
      const col = anshSeat.seatCol + ahead.dc * d;
      const row = anshSeat.seatRow + ahead.dr * d;
      if (!ansh.has(tileKey(col, row))) break;
      if (walkable(col, row)) {
        const seatTile = { col: anshSeat.seatCol, row: anshSeat.seatRow };
        visitSpot = { col, row, facing: facingToward({ col, row }, seatTile) };
        break;
      }
    }
  }
  if (!visitSpot && ansh.size > 0 && (managerSeat || managerStand)) {
    const target = anshSeat ? { col: anshSeat.seatCol, row: anshSeat.seatRow } : null;
    let best: { col: number; row: number } | null = null;
    let bestDist = Infinity;
    for (const t of anshTiles) {
      if (!walkable(t.col, t.row)) continue;
      if (target && t.col === target.col && t.row === target.row) continue;
      const d = target ? Math.abs(t.col - target.col) + Math.abs(t.row - target.row) : 0;
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
      if (!target) break;
    }
    if (best) {
      visitSpot = {
        col: best.col,
        row: best.row,
        facing: target ? facingToward(best, target) : Direction.UP,
      };
    }
  }

  const heldSeatIds = all
    .filter(
      (s) =>
        s === managerSeat ||
        ansh.has(tileKey(s.seatCol, s.seatRow)) ||
        manager.has(tileKey(s.seatCol, s.seatRow)),
    )
    .map((s) => s.uid);

  return { anshSeat, managerSeat, managerStand, visitSpot, heldSeatIds };
}
