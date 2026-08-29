import { LOUNGE_FURNITURE_TYPE_PREFIXES } from '../../constants.js';
import type { PlacedFurniture, TileType as TileTypeVal } from '../types.js';
import { TileType } from '../types.js';
import { getCatalogEntry } from './furnitureCatalog.js';

/** True for sofa / coffee-table variants, including mirrored `:left` types. */
export function isLoungeFurnitureType(type: string): boolean {
  const base = type.split(':')[0];
  return LOUNGE_FURNITURE_TYPE_PREFIXES.some(
    (prefix) => base === prefix || base.startsWith(`${prefix}_`),
  );
}

function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

function isValidFloor(tile: TileTypeVal | undefined): boolean {
  return tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID;
}

/**
 * Walkable tiles of the cafe / lounge: flood-fill from tiles adjacent to
 * sofa and coffee-table furniture, staying on the same floor pattern so a
 * doorway of a different pattern does not leak into the work area.
 *
 * Empty when the layout has no lounge furniture (callers fall back to the
 * office-wide wander pool).
 */
export function getLoungeTiles(
  tileMap: TileTypeVal[][],
  walkableTiles: Array<{ col: number; row: number }>,
  furniture: PlacedFurniture[],
): Array<{ col: number; row: number }> {
  const walkableSet = new Set(walkableTiles.map((t) => tileKey(t.col, t.row)));
  const seeds: Array<{ col: number; row: number }> = [];
  const loungeFloors = new Set<TileTypeVal>();
  const dirs = [
    { dc: 0, dr: 0 },
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ];

  for (const item of furniture) {
    if (!isLoungeFurnitureType(item.type)) continue;
    const entry = getCatalogEntry(item.type);
    const footprintW = entry?.footprintW ?? 1;
    const footprintH = entry?.footprintH ?? 1;
    for (let dr = 0; dr < footprintH; dr++) {
      for (let dc = 0; dc < footprintW; dc++) {
        const col = item.col + dc;
        const row = item.row + dr;
        const floor = tileMap[row]?.[col];
        if (isValidFloor(floor)) loungeFloors.add(floor);
        for (const d of dirs) {
          const nc = col + d.dc;
          const nr = row + d.dr;
          if (!walkableSet.has(tileKey(nc, nr))) continue;
          const seedFloor = tileMap[nr]?.[nc];
          if (!isValidFloor(seedFloor)) continue;
          // Stay on the furniture's floor so a doorway of another pattern
          // cannot seed the work area as lounge.
          if (isValidFloor(floor) && seedFloor !== floor) continue;
          seeds.push({ col: nc, row: nr });
        }
      }
    }
  }

  if (seeds.length === 0 || loungeFloors.size === 0) return [];

  const lounge = new Set<string>();
  const queue: Array<{ col: number; row: number }> = [];
  for (const seed of seeds) {
    const key = tileKey(seed.col, seed.row);
    if (lounge.has(key)) continue;
    lounge.add(key);
    queue.push(seed);
  }

  const floodDirs = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const d of floodDirs) {
      const nc = cur.col + d.dc;
      const nr = cur.row + d.dr;
      const key = tileKey(nc, nr);
      if (lounge.has(key) || !walkableSet.has(key)) continue;
      const floor = tileMap[nr]?.[nc];
      if (floor === undefined || !loungeFloors.has(floor)) continue;
      lounge.add(key);
      queue.push({ col: nc, row: nr });
    }
  }

  const tiles: Array<{ col: number; row: number }> = [];
  for (const key of lounge) {
    const [col, row] = key.split(',').map(Number);
    tiles.push({ col, row });
  }
  return tiles;
}
