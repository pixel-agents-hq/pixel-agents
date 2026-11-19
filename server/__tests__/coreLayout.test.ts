/**
 * The layout's pure operations, called the way the server calls them: a
 * catalogue built from the catalogue data the server's asset loader returns
 * (no sprites, no webview), then seats, walking and edits over an OfficeLayout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  canPlaceFurniture,
  catalogEntry,
  createFurnitureCatalog,
  Direction,
  eraseTile,
  expandLayout,
  findPath,
  type FurnitureCatalog,
  getSurfaceRiders,
  isWalkable,
  layoutToSeats,
  migrateLayoutColors,
  type OfficeLayout,
  pairWorkstations,
  placeNewFurniture,
  rotatedType,
  rotateFurniture,
  TileType,
  toggledType,
  toggleFurnitureState,
  walkGrid,
} from '../../core/src/layout/index.js';
import { loadFurnitureAssets } from '../src/assetLoader.js';

const ASSETS_ROOT = path.resolve(__dirname, '../../webview-ui/public');

let catalog: FurnitureCatalog;
let defaultLayout: OfficeLayout;

beforeAll(async () => {
  const loaded = await loadFurnitureAssets(ASSETS_ROOT);
  if (!loaded) throw new Error('bundled furniture did not load');
  const built = createFurnitureCatalog(loaded.catalog);
  if (!built) throw new Error('catalogue came out empty');
  catalog = built;
  defaultLayout = migrateLayoutColors(
    JSON.parse(
      fs.readFileSync(path.join(ASSETS_ROOT, 'assets', 'default-layout-1.json'), 'utf-8'),
    ) as OfficeLayout,
  );
});

/** A walled room of floor, `cols` x `rows` including the walls. */
function room(cols: number, rows: number): OfficeLayout {
  const tiles: TileType[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
      tiles.push(edge ? TileType.WALL : TileType.FLOOR_1);
    }
  }
  return { version: 1, cols, rows, tiles, furniture: [] };
}

describe('the catalogue from data alone', () => {
  it('knows every variant, with no sprites', () => {
    const desk = catalogEntry(catalog, 'DESK_FRONT');
    expect(desk).toMatchObject({ isDesk: true, footprintW: 3, footprintH: 2 });
    expect(desk).not.toHaveProperty('sprite');
    // Mirrored ":left" variants exist as their own types.
    expect(catalogEntry(catalog, 'PC_SIDE:left')?.orientation).toBe('left');
  });

  it('builds rotation and state groups', () => {
    expect(toggledType(catalog, 'PC_FRONT_OFF')).toBe('PC_FRONT_ON_1');
    expect(toggledType(catalog, 'PC_FRONT_ON_1')).toBe('PC_FRONT_OFF');
    const turned = rotatedType(catalog, 'WOODEN_CHAIR_FRONT', 'cw');
    expect(turned).not.toBeNull();
    expect(rotatedType(catalog, turned!, 'ccw')).toBe('WOODEN_CHAIR_FRONT');
  });

  it('offers only front, off variants to a palette', () => {
    const visible = new Set(catalog.visible.map((e) => e.type));
    expect(visible.has('DESK_FRONT')).toBe(true);
    expect(visible.has('DESK_SIDE')).toBe(false);
    expect(visible.has('PC_FRONT_ON_1')).toBe(false);
  });
});

describe('seats and walking on the bundled default layout', () => {
  it('derives a seat from every chair tile, standing on floor', () => {
    const seats = layoutToSeats(catalog, defaultLayout.furniture);
    expect(seats.size).toBeGreaterThan(0);
    for (const seat of seats.values()) {
      const tile = defaultLayout.tiles[seat.seatRow * defaultLayout.cols + seat.seatCol];
      expect(tile).not.toBe(TileType.WALL);
      expect(tile).not.toBe(TileType.VOID);
      expect(seat.assigned).toBe(false);
    }
  });

  it('pairs seats with PCs', () => {
    const seats = layoutToSeats(catalog, defaultLayout.furniture);
    const pairs = pairWorkstations(seats, defaultLayout.furniture, (t) => catalogEntry(catalog, t));
    expect(pairs.size).toBeGreaterThan(0);
  });

  it('finds a 4-connected path between walkable tiles', () => {
    const { tileMap, blockedTiles } = walkGrid(catalog, defaultLayout);
    const walkable: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < defaultLayout.rows; row++) {
      for (let col = 0; col < defaultLayout.cols; col++) {
        if (isWalkable(col, row, tileMap, blockedTiles)) walkable.push({ col, row });
      }
    }
    expect(walkable.length).toBeGreaterThan(1);
    const start = walkable[0];
    // The farthest tile reachable from the start, so the path is a real one.
    const reachable = walkable.filter(
      (t) => findPath(start.col, start.row, t.col, t.row, tileMap, blockedTiles).length > 0,
    );
    const end = reachable[reachable.length - 1];
    const route = findPath(start.col, start.row, end.col, end.row, tileMap, blockedTiles);
    expect(route[route.length - 1]).toEqual(end);
    let prev = start;
    for (const step of route) {
      expect(Math.abs(step.col - prev.col) + Math.abs(step.row - prev.row)).toBe(1);
      expect(isWalkable(step.col, step.row, tileMap, blockedTiles)).toBe(true);
      prev = step;
    }
  });
});

describe('edits', () => {
  it('places furniture on floor only, never on walls or off the grid', () => {
    const layout = room(8, 8);
    expect(canPlaceFurniture(catalog, layout, 'DESK_FRONT', 2, 2)).toBe(true);
    expect(canPlaceFurniture(catalog, layout, 'DESK_FRONT', 0, 2)).toBe(false);
    expect(canPlaceFurniture(catalog, layout, 'DESK_FRONT', 6, 2)).toBe(false);
    expect(canPlaceFurniture(catalog, layout, 'NO_SUCH_TYPE', 2, 2)).toBe(false);
  });

  it('lets a PC ride a desk, and turns it with the desk', () => {
    let layout = placeNewFurniture(catalog, room(10, 10), 'DESK_FRONT', 2, 3, null);
    const desk = layout.furniture[0];
    layout = placeNewFurniture(catalog, layout, 'PC_FRONT_OFF', 3, 3, null);
    expect(layout.furniture).toHaveLength(2);
    expect(getSurfaceRiders(catalog, layout, desk.uid).map((f) => f.type)).toEqual([
      'PC_FRONT_OFF',
    ]);
    const turned = rotateFurniture(catalog, layout, desk.uid, 'cw');
    expect(turned).not.toBe(layout);
    expect(turned.furniture.find((f) => f.uid === desk.uid)?.type).not.toBe('DESK_FRONT');
  });

  it('toggles a PC on and off', () => {
    const layout = placeNewFurniture(catalog, room(8, 8), 'PC_FRONT_OFF', 2, 2, null);
    const uid = layout.furniture[0].uid;
    const on = toggleFurnitureState(catalog, layout, uid);
    expect(on.furniture[0].type).toBe('PC_FRONT_ON_1');
    expect(toggleFurnitureState(catalog, on, uid).furniture[0].type).toBe('PC_FRONT_OFF');
  });

  it('erases a tile to VOID together with the furniture standing on it', () => {
    const layout = placeNewFurniture(catalog, room(8, 8), 'DESK_FRONT', 2, 2, null);
    const erased = eraseTile(catalog, layout, 3, 3);
    expect(erased.tiles[3 * 8 + 3]).toBe(TileType.VOID);
    expect(erased.furniture).toHaveLength(0);
  });

  it('grows the grid, shifting furniture when it grows left', () => {
    const layout = placeNewFurniture(catalog, room(8, 8), 'DESK_FRONT', 2, 2, null);
    const grown = expandLayout(layout, 'left');
    expect(grown?.layout.cols).toBe(9);
    expect(grown?.layout.furniture[0]).toMatchObject({ col: 3, row: 2 });
    expect(grown?.shift).toEqual({ col: 1, row: 0 });
  });

  it('seats a chair facing its orientation', () => {
    const layout = placeNewFurniture(catalog, room(8, 8), 'WOODEN_CHAIR_BACK', 3, 3, null);
    const seats = [...layoutToSeats(catalog, layout.furniture).values()];
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) expect(seat.facingDir).toBe(Direction.UP);
  });
});
