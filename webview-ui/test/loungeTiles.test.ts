/**
 * Lounge / cafe hangout: furniture identity + flood-fill region.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { getBlockedTiles, layoutToTileMap } from '../src/office/layout/layoutSerializer.js';
import { getLoungeTiles, isLoungeFurnitureType } from '../src/office/layout/loungeTiles.js';
import { getWalkableTiles } from '../src/office/layout/tileMap.js';
import type {
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

test('isLoungeFurnitureType matches sofa and coffee-table variants only', () => {
  assert.equal(isLoungeFurnitureType('SOFA'), true);
  assert.equal(isLoungeFurnitureType('SOFA_FRONT'), true);
  assert.equal(isLoungeFurnitureType('SOFA_SIDE:left'), true);
  assert.equal(isLoungeFurnitureType('COFFEE_TABLE'), true);
  assert.equal(isLoungeFurnitureType('COFFEE'), false);
  assert.equal(isLoungeFurnitureType('WOODEN_CHAIR_SIDE'), false);
  assert.equal(isLoungeFurnitureType('DESK_FRONT'), false);
});

test('getLoungeTiles is empty when the layout has no lounge furniture', () => {
  const tileMap = buildFloorMap(5, 5, TileType.FLOOR_1);
  const walkable = allTiles(5, 5);
  const tiles = getLoungeTiles(tileMap, walkable, []);
  assert.deepEqual(tiles, []);
});

test('default layout lounge is the cafe room, not the office desks', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, '../public/assets/default-layout-1.json'), 'utf8');
  const layout = JSON.parse(raw) as OfficeLayout;
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);
  const walkable = getWalkableTiles(tileMap, blocked);
  const lounge = getLoungeTiles(tileMap, walkable, layout.furniture);

  assert.ok(lounge.length > 0, 'default cafe should produce lounge tiles');
  for (const t of lounge) {
    assert.equal(
      tileMap[t.row][t.col],
      TileType.FLOOR_1,
      `lounge tile ${t.col},${t.row} should stay on the cafe floor`,
    );
    assert.ok(t.col >= 10, `office desk col ${t.col} leaked into lounge`);
  }
  assert.ok(
    lounge.some((t) => t.col >= 14 && t.row >= 13 && t.row <= 16),
    'tiles around the sofa cluster should be in the lounge',
  );
});

test('getLoungeTiles stays on the cafe floor and does not leak into the office', () => {
  // 6×3: left 3 cols FLOOR_7 (office), right 3 cols FLOOR_1 (cafe).
  // A sofa seed at (4, 1) is on the cafe side.
  const tileMap: TileTypeVal[][] = [
    [
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
    ],
    [
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
    ],
    [
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_7,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
    ],
  ];
  const walkable = allTiles(6, 3);
  const furniture: PlacedFurniture[] = [{ uid: 'sofa-1', type: 'SOFA_FRONT', col: 4, row: 1 }];
  const lounge = getLoungeTiles(tileMap, walkable, furniture);
  assert.ok(lounge.length > 0, 'expected cafe tiles');
  for (const t of lounge) {
    assert.equal(
      tileMap[t.row][t.col],
      TileType.FLOOR_1,
      `office tile ${t.col},${t.row} leaked into lounge`,
    );
  }
  assert.ok(
    lounge.some((t) => t.col === 3 && t.row === 1),
    'cafe tiles connected to the sofa should be included',
  );
});

function buildFloorMap(cols: number, rows: number, floor: TileTypeVal): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(floor);
    }
    map.push(row);
  }
  return map;
}

function allTiles(cols: number, rows: number): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c, row: r });
    }
  }
  return tiles;
}
