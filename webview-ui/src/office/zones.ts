/**
 * Living-office zones (docs/office/DESIGN.md): layout Areas with reserved
 * labels, parsed into the places the destination engine sends characters to.
 *
 * Pure and DOM-free, with the furniture catalog injected (`footprint`), so it
 * unit-tests in the Node runner. A layout without these labels parses to no
 * zones and no door, and every living-office behaviour is skipped.
 */

import { ZONE_ASHTRAY_TYPE_PREFIX, ZONE_SERVER_RACK_TYPE_PREFIX } from '../constants.js';
import { knockSpots } from './anshOffice.js';
import { isWalkable } from './layout/tileMap.js';
import type { Seat, TileType as TileTypeVal, ZoneTarget } from './types.js';
import { Direction, TileType } from './types.js';

/** The reserved Area labels. `Dev` is the desks' room: not routed to. */
export const ZoneLabel = {
  DEV: 'Dev',
  ENTRANCE: 'Entrance',
  SMOKE: 'Smoke',
  LOUNGE: 'Lounge',
  MEETING: 'Meeting',
  SERVER: 'Server',
  CAFE: 'Cafe',
  /** Ansh's private office (phase M): permission requests knock on its door. */
  ANSH: 'Ansh',
  /** The Manager's desk outside it: the Manager NPC's, never an agent's desk. */
  MANAGER: 'Manager',
} as const;
export type ZoneLabel = (typeof ZoneLabel)[keyof typeof ZoneLabel];

/** Zones characters are sent to (everything but the desks' room). */
const ROUTED_LABELS: readonly ZoneLabel[] = [
  ZoneLabel.ENTRANCE,
  ZoneLabel.SMOKE,
  ZoneLabel.LOUNGE,
  ZoneLabel.MEETING,
  ZoneLabel.SERVER,
  ZoneLabel.CAFE,
  ZoneLabel.ANSH,
];

/** Area label → reserved zone label, matched case-insensitively ("lounge"). */
export function toZoneLabel(label: string | null | undefined): ZoneLabel | null {
  if (!label) return null;
  const wanted = label.trim().toLowerCase();
  for (const z of Object.values(ZoneLabel)) {
    if (z.toLowerCase() === wanted) return z;
  }
  return null;
}

/** Is an Area label one of the routed zones (a room, not a desk)? */
export function isRoutedZoneLabel(label: string | null | undefined): boolean {
  const z = toZoneLabel(label);
  return z !== null && z !== ZoneLabel.DEV;
}

/** A place in a zone: a seat to sit on or a spot to stand at. */
export interface ZonePlace extends ZoneTarget {
  zone: ZoneLabel;
}

export interface Zone {
  label: ZoneLabel;
  tiles: Array<{ col: number; row: number }>;
  /** Where a character sent here goes: Lounge/Meeting/Cafe seats, Smoke/Server spots. */
  places: ZonePlace[];
}

/** The Entrance door: where new agents appear and leaving ones walk to. */
export interface ZoneDoor {
  col: number;
  row: number;
  /** Faces into the office (arriving)... */
  inward: Direction;
  /** ...and out of it (leaving). */
  outward: Direction;
}

export interface OfficeZones {
  /** Routed zones present in the layout (never Dev). */
  zones: Map<ZoneLabel, Zone>;
  door: ZoneDoor | null;
  /** Footprint tiles (`col,row`) of the Server room's racks. */
  rackTiles: string[];
  /** The Smoke terrace's ashtrays (they fill with butts while people wait). */
  ashtrays: Array<{ type: string; col: number; row: number }>;
}

export const NO_ZONES: OfficeZones = { zones: new Map(), door: null, rackTiles: [], ashtrays: [] };

/** A furniture type's footprint (and its walkable background rows on top), from
 *  the catalog; undefined when unknown. */
export type FootprintOf = (type: string) => { w: number; h: number; bgRows?: number } | undefined;

export interface ZoneLayoutInput {
  cols: number;
  rows: number;
  areaTiles?: Array<string | null>;
  furniture: ReadonlyArray<{ type: string; col: number; row: number }>;
  tileMap: TileTypeVal[][];
  blockedTiles: ReadonlySet<string>;
  seats: ReadonlyMap<string, Seat>;
  footprint: FootprintOf;
}

export const spotKey = (col: number, row: number): string => `spot:${col},${row}`;

const NEIGHBOURS: ReadonlyArray<{ dc: number; dr: number; facing: Direction }> = [
  // From the neighbour, face back at the furniture tile.
  { dc: 0, dr: 1, facing: Direction.UP }, // below it
  { dc: -1, dr: 0, facing: Direction.RIGHT }, // left of it
  { dc: 1, dr: 0, facing: Direction.LEFT }, // right of it
  { dc: 0, dr: -1, facing: Direction.DOWN }, // above it
];

const OPPOSITE: Record<Direction, Direction> = {
  [Direction.UP]: Direction.DOWN,
  [Direction.DOWN]: Direction.UP,
  [Direction.LEFT]: Direction.RIGHT,
  [Direction.RIGHT]: Direction.LEFT,
};

/** Parse a layout's zones. */
export function parseZones(input: ZoneLayoutInput): OfficeZones {
  const { cols, rows, areaTiles, tileMap } = input;
  if (!areaTiles || areaTiles.length === 0) return NO_ZONES;

  const labelAt = (col: number, row: number): ZoneLabel | null => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return toZoneLabel(areaTiles[row * cols + col]);
  };
  const walkable = (col: number, row: number): boolean =>
    isWalkable(col, row, tileMap, input.blockedTiles as Set<string>);

  // Tiles per routed zone.
  const tilesByZone = new Map<ZoneLabel, Array<{ col: number; row: number }>>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const z = labelAt(col, row);
      if (!z || !ROUTED_LABELS.includes(z)) continue;
      let list = tilesByZone.get(z);
      if (!list) tilesByZone.set(z, (list = []));
      list.push({ col, row });
    }
  }
  if (tilesByZone.size === 0) return NO_ZONES;

  // Furniture footprints per zone (an item belongs to the zone of its anchor tile
  // or any of its footprint tiles), for the furniture the spots key on.
  const itemsIn = (zone: ZoneLabel, prefix: string) => {
    const out: Array<{
      type: string;
      col: number;
      row: number;
      w: number;
      h: number;
      bgRows: number;
    }> = [];
    for (const item of input.furniture) {
      if (!item.type.startsWith(prefix)) continue;
      const fp = input.footprint(item.type) ?? { w: 1, h: 1 };
      let inZone = false;
      for (let dr = 0; dr < fp.h && !inZone; dr++) {
        for (let dc = 0; dc < fp.w && !inZone; dc++) {
          if (labelAt(item.col + dc, item.row + dr) === zone) inZone = true;
        }
      }
      if (inZone) {
        out.push({ ...item, w: fp.w, h: fp.h, bgRows: fp.bgRows ?? 0 });
      }
    }
    return out;
  };

  const zones = new Map<ZoneLabel, Zone>();
  const spot = (zone: ZoneLabel, col: number, row: number, facing: Direction): ZonePlace => ({
    zone,
    key: spotKey(col, row),
    col,
    row,
    facing,
    sit: false,
  });

  /** Walkable zone tiles 4-adjacent to the items (not on them), facing them —
   *  but not above an item's background rows: those are the see-through top
   *  of its sprite, so standing there reads as standing a tile away from it. */
  const spotsAround = (
    zone: ZoneLabel,
    items: Array<{ col: number; row: number; w: number; h: number; bgRows?: number }>,
  ): ZonePlace[] => {
    const own = new Set<string>();
    for (const it of items) {
      for (let dr = 0; dr < it.h; dr++) {
        for (let dc = 0; dc < it.w; dc++) own.add(`${it.col + dc},${it.row + dr}`);
      }
    }
    const out: ZonePlace[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      for (let dr = 0; dr < it.h; dr++) {
        for (let dc = 0; dc < it.w; dc++) {
          for (const n of NEIGHBOURS) {
            if (n.dr === -1 && dr < (it.bgRows ?? 0)) continue;
            const col = it.col + dc + n.dc;
            const row = it.row + dr + n.dr;
            const k = `${col},${row}`;
            if (own.has(k) || seen.has(k)) continue;
            if (labelAt(col, row) !== zone || !walkable(col, row)) continue;
            seen.add(k);
            out.push(spot(zone, col, row, n.facing));
          }
        }
      }
    }
    return out;
  };

  /** Fallback: every walkable tile of the zone. */
  const anyTile = (zone: ZoneLabel, facing: Direction): ZonePlace[] =>
    (tilesByZone.get(zone) ?? [])
      .filter((t) => walkable(t.col, t.row))
      .map((t) => spot(zone, t.col, t.row, facing));

  const seatsIn = (zone: ZoneLabel): ZonePlace[] => {
    const out: ZonePlace[] = [];
    for (const [uid, seat] of input.seats) {
      if (labelAt(seat.seatCol, seat.seatRow) !== zone) continue;
      out.push({
        zone,
        key: uid,
        col: seat.seatCol,
        row: seat.seatRow,
        facing: seat.facingDir,
        sit: true,
      });
    }
    return out;
  };

  let rackTiles: string[] = [];
  let ashtrays: OfficeZones['ashtrays'] = [];
  for (const [label, tiles] of tilesByZone) {
    let places: ZonePlace[] = [];
    switch (label) {
      case ZoneLabel.SMOKE: {
        const trays = itemsIn(label, ZONE_ASHTRAY_TYPE_PREFIX);
        ashtrays = trays.map(({ type, col, row }) => ({ type, col, row }));
        places = spotsAround(label, trays);
        if (places.length === 0) places = anyTile(label, Direction.DOWN);
        break;
      }
      case ZoneLabel.SERVER: {
        const racks = itemsIn(label, ZONE_SERVER_RACK_TYPE_PREFIX);
        // In front of the racks: the row below each footprint, facing up at them.
        const seen = new Set<string>();
        for (const r of racks) {
          for (let dc = 0; dc < r.w; dc++) {
            const col = r.col + dc;
            const row = r.row + r.h;
            const k = `${col},${row}`;
            if (seen.has(k) || labelAt(col, row) !== label || !walkable(col, row)) continue;
            seen.add(k);
            places.push(spot(label, col, row, Direction.UP));
          }
        }
        if (places.length === 0) places = spotsAround(label, racks);
        if (places.length === 0) places = anyTile(label, Direction.UP);
        rackTiles = racks.flatMap((r) => {
          const out: string[] = [];
          for (let dr = 0; dr < r.h; dr++) {
            for (let dc = 0; dc < r.w; dc++) out.push(`${r.col + dc},${r.row + dr}`);
          }
          return out;
        });
        break;
      }
      case ZoneLabel.LOUNGE:
      case ZoneLabel.MEETING:
      case ZoneLabel.CAFE:
        places = seatsIn(label);
        break;
      case ZoneLabel.ENTRANCE:
        places = []; // the door, below
        break;
      case ZoneLabel.ANSH:
        // Nobody walks in: a permission request knocks just outside the door.
        places = knockSpots(
          label,
          tiles,
          (c, r) => labelAt(c, r) === label,
          walkable,
          (c, r) => {
            const t = tileMap[r]?.[c];
            return t === undefined || t === TileType.WALL || t === TileType.VOID;
          },
        );
        break;
    }
    zones.set(label, { label, tiles, places });
  }

  return {
    zones,
    door: findDoor(tilesByZone.get(ZoneLabel.ENTRANCE) ?? [], input),
    rackTiles,
    ashtrays,
  };
}

/**
 * The Entrance door: the walkable Entrance tile on the map's outer edge, or
 * the one nearest to it. A door several tiles wide resolves to its middle.
 */
function findDoor(
  tiles: Array<{ col: number; row: number }>,
  input: ZoneLayoutInput,
): ZoneDoor | null {
  const { cols, rows } = input;
  let best: Array<{ col: number; row: number; side: Direction }> = [];
  let bestDist = Infinity;
  for (const t of tiles) {
    if (!isWalkable(t.col, t.row, input.tileMap, input.blockedTiles as Set<string>)) continue;
    // Distance to each edge; `side` is the way out through the nearest one.
    const edges: Array<{ d: number; side: Direction }> = [
      { d: t.col, side: Direction.LEFT },
      { d: cols - 1 - t.col, side: Direction.RIGHT },
      { d: t.row, side: Direction.UP },
      { d: rows - 1 - t.row, side: Direction.DOWN },
    ];
    const nearest = edges.reduce((a, b) => (b.d < a.d ? b : a));
    if (nearest.d < bestDist) {
      bestDist = nearest.d;
      best = [{ ...t, side: nearest.side }];
    } else if (nearest.d === bestDist) {
      best.push({ ...t, side: nearest.side });
    }
  }
  if (best.length === 0) return null;
  best.sort((a, b) => a.col - b.col || a.row - b.row);
  const mid = best[Math.floor((best.length - 1) / 2)];
  return { col: mid.col, row: mid.row, outward: mid.side, inward: OPPOSITE[mid.side] };
}
