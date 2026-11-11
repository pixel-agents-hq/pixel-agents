/**
 * Wall sets: every wall tile wears a set and a colour of its own, painted like
 * floors, and walls of different heights never join.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, describe, test } from 'vitest';

import {
  eraseTile,
  expandLayout,
  paintTile,
  paintWall,
  wallStrokeAdds,
  wallStrokeTile,
} from '../src/office/editor/editorActions.js';
import type { ColorValue, OfficeLayout, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import { getWallInstances, setWallSprites } from '../src/office/wallTiles.js';

const NAVY: ColorValue = { h: 214, s: 30, b: -100, c: -55 };
const TAN: ColorValue = { h: 30, s: 35, b: -10, c: 0 };
const FLOOR = { type: TileType.FLOOR_1, color: { h: 0, s: 0, b: 0, c: 0 } };

/** A 3×1 strip of floor. */
function strip(): OfficeLayout {
  return {
    version: 1,
    cols: 3,
    rows: 1,
    tiles: [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
    tileColors: [null, null, null],
    furniture: [],
  };
}

describe('painting walls', () => {
  test('a wall is painted in its set and colour, and a plain one records no set', () => {
    const brick = paintWall(strip(), 0, 0, 1, NAVY);
    assert.equal(brick.tiles[0], TileType.WALL);
    assert.deepEqual(brick.tileColors?.[0], NAVY);
    assert.equal(brick.wallSets?.[0], 1);

    const plain = paintWall(strip(), 0, 0, 0, NAVY);
    assert.equal(plain.wallSets, undefined);
  });

  test('painting the wall a tile already is changes nothing', () => {
    const once = paintWall(strip(), 0, 0, 2, TAN);
    assert.equal(paintWall(once, 0, 0, 2, TAN), once);
  });

  test('another set or colour restyles a standing wall', () => {
    const brick = paintWall(strip(), 0, 0, 1, NAVY);
    const planks = paintWall(brick, 0, 0, 2, NAVY);
    assert.equal(planks.wallSets?.[0], 2);
    const tan = paintWall(planks, 0, 0, 2, TAN);
    assert.deepEqual(tan.tileColors?.[0], TAN);
  });

  test('a tile that stops being a wall drops its set', () => {
    const brick = paintWall(strip(), 1, 0, 1, NAVY);
    assert.equal(paintTile(brick, 1, 0, TileType.FLOOR_2, FLOOR.color).wallSets?.[1], null);
    assert.equal(eraseTile(brick, 1, 0).wallSets?.[1], null);
  });

  test('the sets move with their tiles when the grid grows left', () => {
    const brick = paintWall(strip(), 0, 0, 3, NAVY);
    const grown = expandLayout(brick, 'left');
    assert.ok(grown);
    assert.deepEqual(grown.layout.wallSets, [null, 3, null, null]);
  });
});

describe('a wall stroke', () => {
  const brickNavy = { set: 1, color: NAVY };

  test('starting on the very wall it paints removes walls', () => {
    const layout = paintWall(strip(), 0, 0, 1, NAVY);
    assert.equal(wallStrokeAdds(layout, 0, 0, brickNavy), false);
    const removed = wallStrokeTile(layout, 0, 0, false, brickNavy, FLOOR);
    assert.equal(removed.tiles[0], TileType.FLOOR_1);
  });

  test('starting on floor or on a different wall paints, restyling the walls it crosses', () => {
    const layout = paintWall(strip(), 1, 0, 2, TAN);
    assert.equal(wallStrokeAdds(layout, 0, 0, brickNavy), true);
    assert.equal(wallStrokeAdds(layout, 1, 0, brickNavy), true);
    const restyled = wallStrokeTile(layout, 1, 0, true, brickNavy, FLOOR);
    assert.equal(restyled.wallSets?.[1], 1);
    assert.deepEqual(restyled.tileColors?.[1], NAVY);
  });

  test('an older layout with no sets toggles its plain walls as before', () => {
    const old: OfficeLayout = {
      ...strip(),
      tiles: [TileType.WALL, 1, 1],
      tileColors: [NAVY, null, null],
    };
    assert.equal(wallStrokeAdds(old, 0, 0, { set: 0, color: NAVY }), false);
  });
});

describe('wall joins', () => {
  /** A set whose every piece is `height` opaque rows tall, tagged by mask. */
  function fakeSet(height: number, tag: string): SpriteData[] {
    return Array.from({ length: 16 }, (_, mask) =>
      Array.from({ length: 32 }, (_, row) =>
        Array.from({ length: 16 }, () => (row >= 32 - height ? `#${tag}${mask.toString(16)}` : '')),
      ),
    );
  }

  beforeEach(() => {
    // 0 and 1 are full height, 2 is a low partition.
    setWallSprites([fakeSet(32, 'A'), fakeSet(32, 'B'), fakeSet(20, 'C')]);
  });

  const maskOf = (sprite: SpriteData) => parseInt(sprite[31][0].slice(-1), 16);

  test('walls of the same height join across sets; a lower one closes its own ends', () => {
    const W = TileType.WALL;
    const tileMap = [[W, W, W]];
    const instances = getWallInstances(tileMap, undefined, 3, [0, 1, 2]);
    assert.deepEqual(
      instances.map((i) => maskOf(i.sprite)),
      [2 /* E */, 8 /* W only: the low wall doesn't join */, 0],
    );
  });

  test('a wall two tiles thick has no seam down its middle', () => {
    // Pieces outlined on both sides, as a south-running column is drawn.
    const EDGE = 'edge';
    const TOP = 'top';
    const outlined: SpriteData[] = Array.from({ length: 16 }, () =>
      Array.from({ length: 32 }, () =>
        Array.from({ length: 16 }, (_, x) => (x === 0 || x === 15 ? EDGE : TOP)),
      ),
    );
    setWallSprites([outlined]);
    const W = TileType.WALL;
    const F = TileType.FLOOR_1;
    // Two columns, three tall: the middle row's pieces run both ways.
    const instances = getWallInstances(
      [
        [W, W],
        [W, W],
        [W, W],
      ],
      undefined,
      2,
    );
    const middleLeft = instances[2].sprite;
    const middleRight = instances[3].sprite;
    // The joined sides lose their outline, the outer sides keep it.
    assert.equal(middleLeft[20][15], TOP);
    assert.equal(middleLeft[0][15], TOP);
    assert.equal(middleRight[20][0], TOP);
    assert.equal(middleLeft[20][0], EDGE);
    assert.equal(middleRight[20][15], EDGE);
    // Under the cap only: the cap rows above it are the art's own.
    assert.equal(middleLeft[4][15], EDGE);

    // A plain run beside the column (no diagonal) keeps the seam: its front face shows there.
    const tee = getWallInstances(
      [
        [W, W],
        [W, F],
      ],
      undefined,
      2,
    );
    assert.equal(tee[0].sprite[20][15], EDGE);
  });

  test('an unknown set falls back to set 0', () => {
    const instances = getWallInstances([[TileType.WALL]], undefined, 1, [7]);
    assert.equal(instances[0].sprite[31][0], '#A0');
  });
});
