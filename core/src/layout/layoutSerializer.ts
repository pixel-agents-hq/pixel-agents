/**
 * The layout as the office reads it: tile grid, furniture footprints that block
 * walking or placement, seats derived from chairs, and the layout's (de)serial
 * form with its migrations. Pure: the catalogue is passed in.
 */

import type { FurnitureCatalog } from './catalog.js';
import { catalogEntry } from './catalog.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from './constants.js';
import type {
  ColorValue,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
} from './types.js';
import { Direction, TileType } from './types.js';

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c]);
    }
    map.push(row);
  }
  return map;
}

/**
 * What walking needs to know about a layout: the tile grid and the tiles its
 * furniture blocks (background rows and nothing else left walkable). Chair
 * tiles are blocked too — a character pathfinding to its own seat unblocks
 * that one tile for the search (the office's withOwnSeatUnblocked).
 */
export function walkGrid(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
): { tileMap: TileTypeVal[][]; blockedTiles: Set<string> } {
  return {
    tileMap: layoutToTileMap(layout),
    blockedTiles: getBlockedTiles(catalog, layout.furniture),
  };
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(
  catalog: FurnitureCatalog,
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = catalogEntry(catalog, item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (excludeTiles && excludeTiles.has(key)) continue;
        tiles.add(key);
      }
    }
  }
  return tiles;
}

/**
 * Get tiles blocked for placement purposes — skips top backgroundTiles rows per item.
 * `excluded` uids don't block (a desk moving together with the items on its
 * surface excludes the whole group, so the group's own tiles never block the move).
 */
export function getPlacementBlockedTiles(
  catalog: FurnitureCatalog,
  furniture: PlacedFurniture[],
  excluded?: ReadonlySet<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (excluded?.has(item.uid)) continue;
    const entry = catalogEntry(catalog, item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front':
      return Direction.DOWN;
    case 'back':
      return Direction.UP;
    case 'left':
      return Direction.LEFT;
    case 'right':
    case 'side':
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(
  catalog: FurnitureCatalog,
  furniture: PlacedFurniture[],
): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Build set of all desk tiles
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = catalogEntry(catalog, item.type);
    if (!entry || !entry.isDesk) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP }, // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN }, // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT }, // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT }, // desk is right of chair → face RIGHT
  ];

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = catalogEntry(catalog, item.type);
    if (!entry || entry.category !== 'chairs') continue;

    let seatCount = 0;
    const bgRows = entry.backgroundTiles ?? 0;
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation);
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              break;
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        });
        seatCount++;
      }
    }
  }

  return seats;
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles)
 * @internal */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>();
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`);
  }
  return tiles;
}

/** Default floor colors for the two rooms */
const DEFAULT_LEFT_ROOM_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 }; // warm beige
const DEFAULT_RIGHT_ROOM_COLOR: ColorValue = { h: 25, s: 45, b: 5, c: 10 }; // warm brown

/** Create a minimal fallback layout (used only when no default-layout.json exists) */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL;
  const F1 = TileType.FLOOR_1;
  const F2 = TileType.FLOOR_2;

  const tiles: TileTypeVal[] = [];
  const tileColors: Array<ColorValue | null> = [];

  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      if (r === 0 || r === DEFAULT_ROWS - 1 || c === 0 || c === DEFAULT_COLS - 1) {
        tiles.push(W);
        tileColors.push(null);
      } else if (c < 10) {
        tiles.push(F1);
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
      } else {
        tiles.push(F2);
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
      }
    }
  }

  // Minimal fallback with no furniture — the default-layout.json provides the real default
  return { version: 1, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tiles, tileColors, furniture: [] };
}

/** Serialize layout to JSON string
 * @internal */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

// ── Furniture type migration ────────────────────────────────────

/** Map old hardcoded FurnitureType values to new manifest-based IDs */
const LEGACY_TYPE_MAP: Record<string, string | null> = {
  desk: 'DESK_FRONT',
  chair: 'WOODEN_CHAIR_FRONT',
  bookshelf: 'BOOKSHELF',
  plant: 'PLANT',
  cooler: null, // no equivalent in new assets — remove
  whiteboard: 'WHITEBOARD',
  pc: 'PC_FRONT_OFF',
  lamp: null, // no equivalent in new assets — remove
};

/** Migrate old furniture type strings to new manifest IDs */
function migrateFurnitureTypes(furniture: PlacedFurniture[]): PlacedFurniture[] {
  const migrated: PlacedFurniture[] = [];
  for (const item of furniture) {
    const newType = LEGACY_TYPE_MAP[item.type];
    if (newType === undefined) {
      // Not a legacy type — keep as-is
      migrated.push(item);
    } else if (newType !== null) {
      // Migrate to new type
      migrated.push({ ...item, type: newType });
    }
    // newType === null → remove the item (no equivalent)
  }
  return migrated;
}

/** Deserialize layout from JSON string, migrating old tile types if needed
 * @internal */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    return layoutFromJson(JSON.parse(json));
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * An already-parsed layout (layout.json as read, a message's payload) as the
 * layout model, migrated, or null when it isn't one. The result shares the
 * input's arrays: treat both as read-only, as every edit op does.
 */
export function layoutFromJson(obj: unknown): OfficeLayout | null {
  if (!obj || typeof obj !== 'object') return null;
  const candidate = obj as Partial<OfficeLayout>;
  if (
    candidate.version === 1 &&
    Array.isArray(candidate.tiles) &&
    Array.isArray(candidate.furniture)
  ) {
    return migrateLayout(candidate as OfficeLayout);
  }
  return null;
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout);
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. Also migrates old furniture type strings and old VOID value.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  // Migrate furniture types
  layout = { ...layout, furniture: migrateFurnitureTypes(layout.furniture) };

  // Migrate old VOID value (was 8, now 255) — only for legacy layouts since FLOOR_8 reuses value 8
  const OLD_VOID = 8;
  if (!layout.layoutRevision && layout.tiles.includes(OLD_VOID as TileTypeVal)) {
    layout = {
      ...layout,
      tiles: layout.tiles.map((t) => (t === OLD_VOID ? (TileType.VOID as TileTypeVal) : t)),
    };
  }

  // Default pets to empty array if absent (backward-compat for legacy layouts).
  if (!layout.pets) {
    layout = { ...layout, pets: [] };
  }

  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout; // Already migrated tile colors
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<ColorValue | null> = [];
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null);
        break;
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
        break;
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
        break;
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push({ h: 280, s: 40, b: -5, c: 0 });
        break;
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push({ h: 35, s: 25, b: 10, c: 0 });
        break;
      default:
        // Floor tile types without colors — use neutral gray
        tileColors.push(tile > 0 && tile !== TileType.VOID ? { h: 0, s: 0, b: 0, c: 0 } : null);
    }
  }

  return { ...layout, tileColors };
}
