/**
 * The living office's ambience wired to OfficeState's world (phase C): the
 * furniture as it looks right now (windows by the time of day, live clocks,
 * name plates on occupied Dev desks), the Café counter the coffee runs head
 * for, and the receptionist's post. OfficeState calls these from its own
 * rebuilds; the rules themselves are in ambience.ts, namePlates.ts,
 * coffeeRuns.ts and receptionist.ts.
 */

import {
  CLOCK_FACE_TYPE,
  NAME_PLATE_TYPE,
  RECEPTIONIST_ID,
  RECEPTIONIST_PALETTE,
} from '../../constants.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { isWalkable } from '../layout/tileMap.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
import type { FootprintOf, OfficeZones } from '../zones.js';
import { NO_ZONES, toZoneLabel, ZoneLabel } from '../zones.js';
import { clockSprite, timeOfDay, withWindowsAt } from './ambience.js';
import { createCharacter } from './characters.js';
import { cafeCounterSpots } from './coffeeRuns.js';
import type { DeskFootprint } from './namePlates.js';
import { namePlatePlacement } from './namePlates.js';
import { receptionPost } from './receptionist.js';

/** What the ambience reads of the office. */
export interface AmbienceWorld {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  seats: Map<string, Seat>;
  zones: OfficeZones;
}

const footprint: FootprintOf = (type) => {
  const entry = getCatalogEntry(type);
  return entry
    ? { w: entry.footprintW, h: entry.footprintH, bgRows: entry.backgroundTiles ?? 0 }
    : undefined;
};

const walkableIn =
  (world: AmbienceWorld) =>
  (col: number, row: number): boolean =>
    isWalkable(col, row, world.tileMap, world.blockedTiles);

// ── Furniture ─────────────────────────────────────────────────

/** The layout's furniture with its windows showing the time of day. */
export function furnitureAt(furniture: readonly PlacedFurniture[], date: Date): PlacedFurniture[] {
  return withWindowsAt(furniture, timeOfDay(date), (type) => getCatalogEntry(type) !== undefined);
}

/** The desks on the floor, for the name plates. */
function deskFootprints(furniture: readonly PlacedFurniture[]): DeskFootprint[] {
  const desks: DeskFootprint[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry?.isDesk) continue;
    desks.push({
      col: item.col,
      row: item.row,
      w: entry.footprintW,
      h: entry.footprintH,
      spriteH: entry.sprite.length,
    });
  }
  return desks;
}

/** A plate on the desk in front of each seat held by an agent in the Dev room. */
export function namePlateInstances(
  world: AmbienceWorld,
  characters: Iterable<Character>,
): FurnitureInstance[] {
  const plate = getCatalogEntry(NAME_PLATE_TYPE);
  const areaTiles = world.layout.areaTiles;
  if (!plate || !areaTiles || areaTiles.length === 0) return [];
  let desks: DeskFootprint[] | null = null;
  const out: FurnitureInstance[] = [];
  for (const ch of characters) {
    if (ch.leaving || !ch.seatId || !ch.directoryName) continue;
    const seat = world.seats.get(ch.seatId);
    if (!seat) continue;
    const label = areaTiles[seat.seatRow * world.layout.cols + seat.seatCol];
    if (toZoneLabel(label) !== ZoneLabel.DEV) continue;
    desks ??= deskFootprints(world.layout.furniture);
    const at = namePlatePlacement(seat, desks);
    if (!at) continue;
    out.push({ sprite: plate.sprite, x: at.x, y: at.y, zY: at.zY, plateText: ch.directoryName });
  }
  return out;
}

/** The instances with every CLOCK_FACE showing the time (its hands drawn). */
export function withLiveClocks(instances: FurnitureInstance[], date: Date): FurnitureInstance[] {
  const face = getCatalogEntry(CLOCK_FACE_TYPE)?.sprite;
  if (!face) return instances;
  let live: FurnitureInstance[] | null = null;
  instances.forEach((inst, i) => {
    if (inst.sprite !== face) return;
    live ??= instances.slice();
    live[i] = { ...inst, sprite: clockSprite(face, date) };
  });
  return live ?? instances;
}

// ── The Café counter ──────────────────────────────────────────

/** The places a coffee run goes, as a Café-only OfficeZones for choosePlace:
 *  the counter in front of the coffee machine, else the Café's own places. */
export function coffeeZones(world: AmbienceWorld): OfficeZones {
  const cafe = world.zones.zones.get(ZoneLabel.CAFE);
  if (!cafe) return NO_ZONES;
  const counter = cafeCounterSpots({
    cols: world.layout.cols,
    rows: world.layout.rows,
    areaTiles: world.layout.areaTiles,
    furniture: world.layout.furniture,
    footprint,
    walkable: walkableIn(world),
  });
  const places = counter.length > 0 ? counter : cafe.places;
  return { ...NO_ZONES, zones: new Map([[ZoneLabel.CAFE, { ...cafe, places }]]) };
}

// ── The receptionist ──────────────────────────────────────────

/**
 * Seat the receptionist at her post (reserving its chair), reusing `current`
 * so a layout rebuild keeps her. Null when the layout has no Entrance
 * reception desk. Call after the seats are (re)built and unassigned, before
 * agents take theirs.
 */
export function placeReceptionist(
  world: AmbienceWorld,
  current: Character | null,
): Character | null {
  const post = receptionPost({
    cols: world.layout.cols,
    rows: world.layout.rows,
    areaTiles: world.layout.areaTiles,
    furniture: world.layout.furniture,
    footprint,
    seats: world.seats,
    walkable: walkableIn(world),
  });
  if (!post) return null;
  if (post.seatId) world.seats.get(post.seatId)!.assigned = true;
  const ch = current ?? createCharacter(RECEPTIONIST_ID, RECEPTIONIST_PALETTE, null, null, 0);
  ch.isReceptionist = true;
  ch.isActive = false;
  ch.seatId = null; // not an agent's seat: nothing frees or persists it
  ch.tileCol = post.col;
  ch.tileRow = post.row;
  ch.x = post.col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = post.row * TILE_SIZE + TILE_SIZE / 2;
  ch.dir = post.facing;
  ch.state = post.seatId ? CharacterState.TYPE : CharacterState.IDLE;
  ch.frame = 0;
  ch.frameTimer = 0;
  ch.path = [];
  return ch;
}
