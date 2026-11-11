/**
 * Unit tests for the pure layout-editor rules in editorActions.ts that the e2e
 * specs can only reach through a real VS Code window.
 *
 * The catalog is a hand-built slice of the bundled assets with the same
 * footprints, background rows and rotation groups: DESK is 2-way (front 3x2 ↔
 * side 1x4), PC rotates front → side, COFFEE and WOODEN_CHAIR_FRONT don't.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import {
  dropFurniture,
  furnitureInBox,
  removeFurnitureGroup,
  rotateFurniture,
  rotateFurnitureGroup,
  setFurnitureColors,
} from '../src/office/editor/editorActions.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

function asset(
  id: string,
  footprintW: number,
  footprintH: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category: 'misc',
    width: footprintW * 16,
    height: footprintH * 16,
    footprintW,
    footprintH,
    isDesk: false,
    ...extra,
  };
}

beforeAll(() => {
  const catalog = [
    asset('DESK_FRONT', 3, 2, {
      isDesk: true,
      groupId: 'DESK',
      orientation: 'front',
      rotationScheme: '2-way',
      backgroundTiles: 1,
    }),
    asset('DESK_SIDE', 1, 4, {
      isDesk: true,
      groupId: 'DESK',
      orientation: 'side',
      rotationScheme: '2-way',
      backgroundTiles: 1,
    }),
    asset('PC_FRONT_OFF', 1, 2, {
      groupId: 'PC',
      orientation: 'front',
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
    }),
    asset('PC_SIDE', 1, 2, {
      groupId: 'PC',
      orientation: 'side',
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
    }),
    asset('COFFEE', 1, 1, { canPlaceOnSurfaces: true }),
    // A screen like the bundled PC: front, side (mirrored for left) and back.
    // Its orientation is the way its user looks: a side screen faces left.
    ...(['front', 'side', 'back'] as const).map((orientation) =>
      asset(`SCREEN_${orientation.toUpperCase()}`, 1, 2, {
        category: 'electronics',
        groupId: 'SCREEN',
        orientation,
        canPlaceOnSurfaces: true,
        backgroundTiles: 1,
        ...(orientation === 'side' ? { mirrorSide: true } : {}),
      }),
    ),
    // A table with one orientation only (no turned art), like the bundled TABLE_FRONT.
    asset('TABLE_FRONT', 3, 4, { isDesk: true, backgroundTiles: 1 }),
    asset('WOODEN_CHAIR_FRONT', 1, 2, { backgroundTiles: 1 }),
  ];
  const sprites = Object.fromEntries(catalog.map((a) => [a.id, [['']]]));
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

function floorLayout(cols: number, rows: number, furniture: PlacedFurniture[]): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

describe('rotateFurniture validates the whole desk group', () => {
  test('a desk with a PC on it rotates both when the group fits', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 3 },
    ]);
    const rotated = rotateFurniture(layout, 'desk', 'cw');
    assert.notEqual(rotated, layout);
    assert.deepEqual(
      rotated.furniture.map((f) => `${f.uid}:${f.type}@${f.col},${f.row}`),
      ['desk:DESK_SIDE@3,3', 'pc:PC_SIDE@3,4'],
    );
  });

  test('refused when a rider would land on another item, though the desk fits', () => {
    // The side desk's top row is a background row, so it may share (3,3) with
    // the chair's solid row; the coffee swung onto (3,3) may not.
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'coffee', type: 'COFFEE', col: 5, row: 3 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 3, row: 2 },
    ]);
    assert.equal(rotateFurniture(layout, 'desk', 'cw'), layout);
  });

  test('the same desk without the coffee rotates — only the rider was in the way', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 3 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 3, row: 2 },
    ]);
    const rotated = rotateFurniture(layout, 'desk', 'cw');
    assert.equal(rotated.furniture.find((f) => f.uid === 'desk')?.type, 'DESK_SIDE');
  });

  test('refused when the rotated group would leave the grid', () => {
    // A 1x4 side desk at row 10 of a 12-row grid covers rows 10-13.
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 3, row: 10 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 10 },
    ]);
    assert.equal(rotateFurniture(layout, 'desk', 'cw'), layout);
  });
});

describe('a Shift+click selection of several items', () => {
  const at = (layout: OfficeLayout) =>
    layout.furniture.map((f) => `${f.uid}@${f.col},${f.row}`).sort();

  test('dragging one carries the others and their riders, and they stay selected', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 1 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 2, row: 1 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 6, row: 1 },
    ]);
    const result = dropFurniture(layout, 'chair', 6, 5, { duplicate: false, with: ['desk'] });
    assert.ok(result);
    assert.deepEqual(at(result.layout), ['chair@6,5', 'desk@1,5', 'pc@2,5']);
    assert.deepEqual(result.selected, ['chair', 'desk']);
  });

  test('the group lands as a whole or not at all', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 1 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 6, row: 1 },
    ]);
    // Two tiles left suits the chair; the desk would leave the grid at col -1.
    assert.equal(dropFurniture(layout, 'chair', 4, 1, { duplicate: false, with: ['desk'] }), null);
  });

  test('Alt-drag copies the whole selection and selects the copies', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'a', type: 'COFFEE', col: 1, row: 1 },
      { uid: 'b', type: 'COFFEE', col: 3, row: 1 },
    ]);
    const result = dropFurniture(layout, 'a', 1, 4, { duplicate: true, with: ['b'] });
    assert.ok(result);
    assert.equal(result.layout.furniture.length, 4);
    const copies = result.selected.map((u) => result.layout.furniture.find((f) => f.uid === u));
    assert.deepEqual(
      copies.map((f) => `${f?.col},${f?.row}`),
      ['1,4', '3,4'],
    );
  });

  test('colours, deletes and rotates all of them', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 1 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 2, row: 1 },
      { uid: 'coffee', type: 'COFFEE', col: 8, row: 8 },
    ]);
    const red = { h: 0, s: 50, b: 0, c: 0 };
    const colored = setFurnitureColors(layout, ['desk', 'coffee'], red);
    assert.deepEqual(
      colored.furniture.map((f) => !!f.color),
      [true, false, true],
    );

    assert.deepEqual(at(removeFurnitureGroup(layout, ['desk', 'coffee'])), ['pc@2,1']);

    // The PC rides on the desk: the desk turns it once, it isn't turned again.
    const rotated = rotateFurnitureGroup(layout, ['desk', 'pc'], 'cw');
    assert.deepEqual(
      rotated.furniture.filter((f) => f.uid !== 'coffee').map((f) => `${f.uid}:${f.type}`),
      ['desk:DESK_SIDE', 'pc:PC_SIDE'],
    );
  });
});

describe('a box selection', () => {
  test('catches every item whose footprint touches the box, from either corner', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 1 }, // cols 1-3, rows 1-2
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 2, row: 1 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 6, row: 1 }, // rows 1-2
      { uid: 'coffee', type: 'COFFEE', col: 9, row: 9 },
    ]);
    assert.deepEqual(furnitureInBox(layout, 3, 2, 6, 4), ['desk', 'chair']);
    assert.deepEqual(furnitureInBox(layout, 6, 4, 3, 2), ['desk', 'chair']);
    assert.deepEqual(furnitureInBox(layout, 4, 4, 5, 8), []);
  });
});

describe('turning a selection of several items', () => {
  const where = (layout: OfficeLayout) =>
    Object.fromEntries(layout.furniture.map((f) => [f.uid, `${f.type}@${f.col},${f.row}`]));

  test('turns as one arrangement: a row of two becomes a column', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'a', type: 'COFFEE', col: 4, row: 4 },
      { uid: 'b', type: 'COFFEE', col: 6, row: 4 },
    ]);
    // 'cw' turns south-facing items east: counter-clockwise on screen, so the
    // right-hand item swings up and the left-hand one down.
    assert.deepEqual(where(rotateFurnitureGroup(layout, ['a', 'b'], 'cw')), {
      a: 'COFFEE@5,5',
      b: 'COFFEE@5,3',
    });
  });

  test('a desk keeps its chair and its PC as the whole set turns', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'desk', type: 'DESK_FRONT', col: 4, row: 4 }, // solid row 5
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 5, row: 4 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 5, row: 5 }, // solid row 6, south of the desk
    ]);
    const turned = where(rotateFurnitureGroup(layout, ['desk', 'chair'], 'cw'));
    // The chair swung from south of the desk to its east; the PC went with the desk.
    assert.equal(turned.desk, 'DESK_SIDE@5,4');
    assert.equal(turned.pc, 'PC_SIDE@5,5');
    assert.equal(turned.chair, 'WOODEN_CHAIR_FRONT@6,5'); // beside the side desk's middle
  });

  test('four turns bring a symmetric arrangement back where it was', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'a', type: 'COFFEE', col: 4, row: 4 },
      { uid: 'b', type: 'COFFEE', col: 6, row: 4 },
      { uid: 'c', type: 'COFFEE', col: 5, row: 6 },
    ]);
    let l = layout;
    for (let i = 0; i < 4; i++) l = rotateFurnitureGroup(l, ['a', 'b', 'c'], 'cw');
    assert.deepEqual(where(l), where(layout));
  });

  test('nothing turns unless every item fits', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'a', type: 'COFFEE', col: 0, row: 0 },
      { uid: 'b', type: 'COFFEE', col: 4, row: 0 },
    ]);
    // The pair would stand on a column from row -2 to row 2.
    assert.equal(rotateFurnitureGroup(layout, ['a', 'b'], 'cw'), layout);
  });
});

describe('a table that has only one orientation', () => {
  test('keeps its shape but turns the PCs on it', () => {
    const layout = floorLayout(12, 12, [
      { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 4 },
      { uid: 'pc', type: 'PC_SIDE', col: 4, row: 4 },
    ]);
    const turned = rotateFurniture(layout, 'table', 'cw');
    const table = turned.furniture.find((f) => f.uid === 'table');
    const pc = turned.furniture.find((f) => f.uid === 'pc');
    assert.equal(table?.type, 'TABLE_FRONT');
    assert.equal(pc?.type, 'PC_FRONT_OFF', 'the side PC turned');
    // ...and its spot swung round the table top, still on the table.
    assert.deepEqual([pc?.col, pc?.row], [4, 6]);
  });

  test('turns its PCs too when it is part of a turning selection', () => {
    const layout = floorLayout(14, 14, [
      { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 4 },
      { uid: 'pc', type: 'PC_SIDE', col: 4, row: 4 },
      { uid: 'chair', type: 'WOODEN_CHAIR_FRONT', col: 5, row: 8 },
    ]);
    const turned = rotateFurnitureGroup(layout, ['table', 'pc', 'chair'], 'cw');
    assert.notEqual(turned, layout);
    assert.equal(turned.furniture.find((f) => f.uid === 'pc')?.type, 'PC_FRONT_OFF');
  });

  test('a table with nothing on it has nothing to turn', () => {
    const layout = floorLayout(12, 12, [{ uid: 'table', type: 'TABLE_FRONT', col: 4, row: 4 }]);
    assert.equal(rotateFurniture(layout, 'table', 'cw'), layout);
  });
});

describe('screens turning on a table', () => {
  test('keep facing outward, towards their users', () => {
    // A side screen on the table's left edge faces left (its user sits to the
    // left); the mirrored one on the right edge faces right.
    const layout = floorLayout(12, 12, [
      { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 4 },
      { uid: 'west', type: 'SCREEN_SIDE', col: 4, row: 5 },
      { uid: 'east', type: 'SCREEN_SIDE:left', col: 6, row: 5 },
    ]);
    // 'cw' turns the arrangement counter-clockwise on screen: the left edge
    // goes to the bottom, the right edge to the top.
    const turned = rotateFurniture(layout, 'table', 'cw');
    const at = (uid: string) => turned.furniture.find((f) => f.uid === uid);
    assert.equal(at('west')?.type, 'SCREEN_FRONT', 'at the bottom, facing down');
    assert.equal(at('east')?.type, 'SCREEN_BACK', 'at the top, facing up');
    assert.ok((at('west')?.row ?? 0) > (at('east')?.row ?? 0));
  });
});
