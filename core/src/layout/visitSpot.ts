/**
 * Where a Visit (CONTEXT.md) can take a character, by the layout alone: a
 * tile checked for the walk, and the spot beside a piece of furniture or a
 * seat, facing it. Pure — the server resolves visits with it, and an office
 * can resolve the same spots. Characters' positions are not part of the
 * layout (each office simulates its own), so "free" here means free of the
 * tiles the caller says are taken (other visits), never of characters.
 */

import type { Facing } from '../messages.js';
import type { FurnitureCatalog } from './catalog.js';
import { catalogEntry } from './catalog.js';
import { VISIT_SPOT_MAX_DISTANCE } from './constants.js';
import { isWalkable } from './tileMap.js';
import type { PlacedFurniture, TilePos, TileType } from './types.js';
import { Direction } from './types.js';

/** The way a character faces, as the protocol (and the Pixel Office MCP) spells it. */
export type { Facing };

export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right'];

const DIRECTION_OF: Record<Facing, Direction> = {
  up: Direction.UP,
  down: Direction.DOWN,
  left: Direction.LEFT,
  right: Direction.RIGHT,
};

/** A facing as the office's Direction. */
export function facingDirection(facing: Facing): Direction {
  return DIRECTION_OF[facing];
}

/** A tile a visit ends on, and the way the character faces there. */
export interface VisitSpot {
  col: number;
  row: number;
  facing: Facing;
}

/** What walking needs: the tile grid and the tiles furniture blocks (core's walkGrid). */
export interface WalkGrid {
  tileMap: TileType[][];
  blockedTiles: Set<string>;
}

/** Why a tile can't be visited, or null when it can. */
export type VisitTileProblem = 'out of grid' | 'not walkable' | 'unreachable';

/**
 * Whether a character starting at `from` (its seat; null = no known start)
 * can walk to `tile`. Without a start only the tile itself is checked.
 */
export function visitTileProblem(
  grid: WalkGrid,
  tile: TilePos,
  from: TilePos | null,
): VisitTileProblem | null {
  const rows = grid.tileMap.length;
  const cols = rows > 0 ? grid.tileMap[0].length : 0;
  if (tile.col < 0 || tile.row < 0 || tile.col >= cols || tile.row >= rows) return 'out of grid';
  if (!isWalkable(tile.col, tile.row, grid.tileMap, grid.blockedTiles)) return 'not walkable';
  if (from && !walkDistances(grid, from).has(key(tile))) return 'unreachable';
  return null;
}

/** Every tile of a placed item's footprint (empty when its type is unknown). */
export function footprintTiles(catalog: FurnitureCatalog, item: PlacedFurniture): TilePos[] {
  const entry = catalogEntry(catalog, item.type);
  if (!entry) return [];
  const tiles: TilePos[] = [];
  for (let dr = 0; dr < entry.footprintH; dr++) {
    for (let dc = 0; dc < entry.footprintW; dc++) {
      tiles.push({ col: item.col + dc, row: item.row + dr });
    }
  }
  return tiles;
}

/**
 * The spot nearest `target` (a footprint, a seat): the walkable tile closest
 * to it (orthogonally beside it when one is free, else up to
 * VISIT_SPOT_MAX_DISTANCE tiles away — a laptop on a deep desk), not in
 * `taken`, reachable from `from` when that is known, facing the target.
 * Ties go to the tile `from` reaches soonest, then to standing in front of
 * the target (below it, facing up — the way the art is drawn). Null when no
 * tile qualifies.
 */
export function spotBeside(
  grid: WalkGrid,
  target: readonly TilePos[],
  opts: { from: TilePos | null; taken?: ReadonlySet<string> },
): VisitSpot | null {
  if (target.length === 0) return null;
  const targetKeys = new Set(target.map(key));
  const reach = opts.from ? walkDistances(grid, opts.from) : null;
  const rows = grid.tileMap.length;
  const cols = rows > 0 ? grid.tileMap[0].length : 0;
  let best: { spot: VisitSpot; score: number[] } | null = null;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = { col, row };
      const k = key(tile);
      if (targetKeys.has(k) || opts.taken?.has(k)) continue;
      if (!isWalkable(col, row, grid.tileMap, grid.blockedTiles)) continue;
      const near = nearestOf(target, tile);
      if (near.distance > VISIT_SPOT_MAX_DISTANCE) continue;
      const walk = reach ? reach.get(k) : 0;
      if (walk === undefined) continue; // unreachable from the start
      const facing = facingToward(tile, near.tile);
      const score = [near.distance, walk, FACING_PREFERENCE.indexOf(facing)];
      if (!best || lessThan(score, best.score)) best = { spot: { col, row, facing }, score };
    }
  }
  return best?.spot ?? null;
}

/** In front first: the art faces down, so the visitor stands below it, facing up. */
const FACING_PREFERENCE: readonly Facing[] = ['up', 'left', 'right', 'down'];

function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function nearestOf(target: readonly TilePos[], tile: TilePos): { tile: TilePos; distance: number } {
  let best = target[0];
  let bestDistance = Infinity;
  for (const t of target) {
    const d = Math.abs(t.col - tile.col) + Math.abs(t.row - tile.row);
    if (d < bestDistance) {
      best = t;
      bestDistance = d;
    }
  }
  return { tile: best, distance: bestDistance };
}

/** The way from `at` toward `to`, along the longer axis (rows win a tie). */
function facingToward(at: TilePos, to: TilePos): Facing {
  const dc = to.col - at.col;
  const dr = to.row - at.row;
  if (Math.abs(dr) >= Math.abs(dc)) return dr < 0 ? 'up' : 'down';
  return dc < 0 ? 'left' : 'right';
}

/** Steps from `from` to every walkable tile it reaches (BFS, 4-connected, as findPath walks).
 *  `from` itself may be blocked — a seat is a chair tile. */
function walkDistances(grid: WalkGrid, from: TilePos): Map<string, number> {
  const distances = new Map<string, number>([[key(from), 0]]);
  const queue: TilePos[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    const d = distances.get(key(at))!;
    for (const [dc, dr] of STEPS) {
      const next = { col: at.col + dc, row: at.row + dr };
      const k = key(next);
      if (distances.has(k)) continue;
      if (!isWalkable(next.col, next.row, grid.tileMap, grid.blockedTiles)) continue;
      distances.set(k, d + 1);
      queue.push(next);
    }
  }
  return distances;
}

const STEPS: ReadonlyArray<[number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

function key(tile: TilePos): string {
  return `${tile.col},${tile.row}`;
}
