/**
 * Unit tests for the pure furniture layout operations in editorActions.ts,
 * focused on the invariants the editor's pick-to-move flow relies on:
 *
 * - placeFurniture rejects overlapping placements (no silent duplicates)
 * - moveFurniture relocates an item while preserving its uid and color
 * - moveFurniture allows a target that overlaps the item's own footprint
 * - canPlaceFurniture's excludeUid ignores only the excluded item
 * - removeFurniture removes by uid and is a no-op for unknown uids
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canPlaceFurniture,
  moveFurniture,
  placeFurniture,
  removeFurniture,
} from '../src/office/editor/editorActions.ts';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.ts';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.ts';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.ts';
import { TileType } from '../src/office/types.ts';

// ── Minimal synthetic catalog ──────────────────────────────────────────────

/** 1x1 transparent sprite placeholder */
const SPRITE = [['transparent']];

const assets: LoadedAssetData = {
  catalog: [
    {
      id: 'test-stool',
      label: 'Stool',
      category: 'chairs',
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
    },
    {
      id: 'test-desk',
      label: 'Desk',
      category: 'desks',
      width: 32,
      height: 16,
      footprintW: 2,
      footprintH: 1,
      isDesk: true,
    },
  ],
  sprites: {
    'test-stool': SPRITE,
    'test-desk': SPRITE,
  },
};

assert.equal(buildDynamicCatalog(assets), true, 'test catalog must build');

// ── Helpers ────────────────────────────────────────────────────────────────

/** All-floor layout with the given furniture */
function makeLayout(cols: number, rows: number, furniture: PlacedFurniture[]): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

// ── placeFurniture ─────────────────────────────────────────────────────────

test('placeFurniture adds an item on free floor', () => {
  const layout = makeLayout(5, 5, []);
  const next = placeFurniture(layout, { uid: 'a', type: 'test-stool', col: 1, row: 1 });
  assert.notEqual(next, layout);
  assert.equal(next.furniture.length, 1);
});

test('placeFurniture rejects a placement overlapping an existing item', () => {
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-stool', col: 1, row: 1 }]);
  const next = placeFurniture(layout, { uid: 'b', type: 'test-stool', col: 1, row: 1 });
  assert.equal(next, layout, 'overlapping placement must return the unchanged layout');
});

// ── moveFurniture (pick-to-move core) ──────────────────────────────────────

test('moveFurniture relocates the item and preserves uid and color', () => {
  const color = { h: 10, s: 20, b: 30, c: 0 };
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-stool', col: 1, row: 1, color }]);
  const next = moveFurniture(layout, 'a', 3, 3);
  assert.notEqual(next, layout);
  assert.equal(next.furniture.length, 1, 'move must never duplicate');
  const moved = next.furniture[0];
  assert.equal(moved.uid, 'a');
  assert.equal(moved.col, 3);
  assert.equal(moved.row, 3);
  assert.deepEqual(moved.color, color, 'color must survive the move');
});

test('moveFurniture allows a target overlapping its own footprint', () => {
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-desk', col: 1, row: 1 }]);
  // 2x1 desk shifted one tile right still covers (2,1) — overlaps itself only
  const next = moveFurniture(layout, 'a', 2, 1);
  assert.notEqual(next, layout, 'self-overlap must not block the move');
  assert.equal(next.furniture[0].col, 2);
});

test('moveFurniture rejects a target overlapping another item', () => {
  const layout = makeLayout(5, 5, [
    { uid: 'a', type: 'test-stool', col: 1, row: 1 },
    { uid: 'b', type: 'test-stool', col: 3, row: 3 },
  ]);
  const next = moveFurniture(layout, 'a', 3, 3);
  assert.equal(next, layout);
});

test('moveFurniture is a no-op for an unknown uid', () => {
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-stool', col: 1, row: 1 }]);
  assert.equal(moveFurniture(layout, 'nope', 2, 2), layout);
});

// ── canPlaceFurniture excludeUid ───────────────────────────────────────────

test('canPlaceFurniture blocks occupied tiles unless the occupant is excluded', () => {
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-stool', col: 1, row: 1 }]);
  assert.equal(canPlaceFurniture(layout, 'test-stool', 1, 1), false);
  assert.equal(canPlaceFurniture(layout, 'test-stool', 1, 1, 'a'), true);
});

test('canPlaceFurniture excludeUid does not ignore other items', () => {
  const layout = makeLayout(5, 5, [
    { uid: 'a', type: 'test-stool', col: 1, row: 1 },
    { uid: 'b', type: 'test-stool', col: 2, row: 1 },
  ]);
  assert.equal(canPlaceFurniture(layout, 'test-stool', 2, 1, 'a'), false);
});

test('canPlaceFurniture rejects walls, void, and out-of-bounds targets', () => {
  const layout = makeLayout(3, 3, []);
  layout.tiles[0] = TileType.WALL; // (0,0)
  layout.tiles[4] = TileType.VOID; // (1,1)
  assert.equal(canPlaceFurniture(layout, 'test-stool', 0, 0), false);
  assert.equal(canPlaceFurniture(layout, 'test-stool', 1, 1), false);
  assert.equal(canPlaceFurniture(layout, 'test-stool', -1, 0), false);
  assert.equal(canPlaceFurniture(layout, 'test-stool', 2, 2), true);
  assert.equal(canPlaceFurniture(layout, 'test-desk', 2, 2), false, '2x1 desk exceeds map edge');
});

// ── removeFurniture ────────────────────────────────────────────────────────

test('removeFurniture removes by uid', () => {
  const layout = makeLayout(5, 5, [
    { uid: 'a', type: 'test-stool', col: 1, row: 1 },
    { uid: 'b', type: 'test-stool', col: 3, row: 3 },
  ]);
  const next = removeFurniture(layout, 'a');
  assert.equal(next.furniture.length, 1);
  assert.equal(next.furniture[0].uid, 'b');
});

test('removeFurniture is a no-op for an unknown uid', () => {
  const layout = makeLayout(5, 5, [{ uid: 'a', type: 'test-stool', col: 1, row: 1 }]);
  assert.equal(removeFurniture(layout, 'nope'), layout);
});
