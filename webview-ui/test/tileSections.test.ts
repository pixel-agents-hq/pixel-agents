/**
 * Sections: touching tiles of one material, picked and restyled together.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { paintWall } from '../src/office/editor/editorActions.js';
import { restyleSection, sectionAt, sectionStyleAt } from '../src/office/editor/tileSections.js';
import type { ColorValue, OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const GREY: ColorValue = { h: 0, s: 0, b: 0, c: 0 };
const TAN: ColorValue = { h: 30, s: 35, b: -10, c: 0 };
const NAVY: ColorValue = { h: 214, s: 30, b: -100, c: -55 };
const F1 = TileType.FLOOR_1;
const F2 = TileType.FLOOR_2;

/**
 * A 4×3 room:
 *   F1 F1 F2 F1
 *   F1 F1 F2 F1
 *   F1 F1 F1 V
 * all grey, except the top-right F1 pair, which is tan.
 */
function room(): OfficeLayout {
  const tiles = [F1, F1, F2, F1, F1, F1, F2, F1, F1, F1, F1, TileType.VOID];
  const tileColors = tiles.map((t, i) =>
    t === TileType.VOID ? null : i === 3 || i === 7 ? { ...TAN } : { ...GREY },
  );
  return { version: 1, cols: 4, rows: 3, tiles, tileColors, furniture: [] };
}

describe('finding a section', () => {
  test('takes every touching floor of the same pattern and colour', () => {
    // The F1 block wraps under the F2 column, through the bottom row.
    assert.deepEqual(sectionAt(room(), 0, 0), [0, 1, 4, 5, 8, 9, 10]);
    assert.deepEqual(sectionAt(room(), 2, 0), [2, 6]);
  });

  test('a different colour is a different section, even in the same pattern', () => {
    assert.deepEqual(sectionAt(room(), 3, 0), [3, 7]);
  });

  test('tiles touching only at a corner are not joined', () => {
    // Tile 7 (tan F1) and tile 10 (grey F1) differ anyway; check with a plain diagonal.
    const layout: OfficeLayout = {
      version: 1,
      cols: 2,
      rows: 2,
      tiles: [F1, F2, F2, F1],
      tileColors: [GREY, GREY, GREY, GREY],
      furniture: [],
    };
    assert.deepEqual(sectionAt(layout, 0, 0), [0]);
  });

  test('void and off-grid tiles have no section', () => {
    assert.deepEqual(sectionAt(room(), 3, 2), []);
    assert.deepEqual(sectionAt(room(), 9, 0), []);
  });

  test('walls join by set and colour, never with floors', () => {
    let layout = room();
    layout = paintWall(layout, 0, 0, 1, NAVY);
    layout = paintWall(layout, 1, 0, 1, NAVY);
    layout = paintWall(layout, 0, 1, 2, NAVY); // another set
    assert.deepEqual(sectionAt(layout, 0, 0), [0, 1]);
    assert.deepEqual(sectionAt(layout, 0, 1), [4]);
    assert.ok(!sectionAt(layout, 1, 1).includes(0));
  });
});

describe('restyling a section', () => {
  test('recolours all of its floors in one edit and leaves the rest alone', () => {
    const layout = room();
    const tiles = sectionAt(layout, 0, 0);
    const next = restyleSection(layout, tiles, { kind: 'floor', tileType: F1, color: NAVY });
    for (const i of tiles) assert.deepEqual(next.tileColors?.[i], NAVY);
    assert.deepEqual(next.tileColors?.[2], GREY);
    assert.deepEqual(next.tileColors?.[3], TAN);
    assert.equal(next.tiles, layout.tiles, 'the pattern did not change, so the tiles are shared');
  });

  test('can change the floor pattern too', () => {
    const layout = room();
    const next = restyleSection(layout, [2, 6], { kind: 'floor', tileType: F1, color: GREY });
    assert.equal(next.tiles[2], F1);
    assert.equal(next.tiles[6], F1);
  });

  test('restyling a section to the look it has changes nothing', () => {
    const layout = room();
    const same = restyleSection(layout, [3, 7], { kind: 'floor', tileType: F1, color: TAN });
    assert.equal(same, layout);
  });

  test('walls take the set and colour; floors in the list are skipped', () => {
    let layout = room();
    layout = paintWall(layout, 0, 0, 1, NAVY);
    layout = paintWall(layout, 1, 0, 1, NAVY);
    const next = restyleSection(layout, [0, 1, 4], { kind: 'wall', set: 3, color: TAN });
    assert.deepEqual(next.wallSets?.slice(0, 2), [3, 3]);
    assert.deepEqual(next.tileColors?.[0], TAN);
    assert.equal(next.tiles[4], F1);
    assert.deepEqual(next.tileColors?.[4], GREY);
  });

  test('back to plain walls records no set', () => {
    const layout = paintWall(room(), 0, 0, 2, NAVY);
    const next = restyleSection(layout, [0], { kind: 'wall', set: 0, color: NAVY });
    assert.equal(next.wallSets?.[0], null);
  });

  test("a tile's style seeds the brush", () => {
    assert.deepEqual(sectionStyleAt(room(), 3), { kind: 'floor', tileType: F1, color: TAN });
    const walled = paintWall(room(), 0, 0, 4, NAVY);
    assert.deepEqual(sectionStyleAt(walled, 0), { kind: 'wall', set: 4, color: NAVY });
    assert.equal(sectionStyleAt(room(), 11), null);
  });
});
