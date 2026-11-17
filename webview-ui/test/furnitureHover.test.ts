/**
 * Hovering and tapping furniture in the office: the piece under the pointer is the
 * layout editor's pick (a surface item wins over the desk under it), a character in
 * front of it wins, plain furniture is never hovered, the Furniture label comes from
 * core's pieceView, a read-only office offers no click, the layout editor opening
 * clears it (the label hears so), and on touch the first tap hovers while the
 * second clicks.
 *
 *   row 3..4  table (4..6, 3..4); KIOSK (5,3) and MUG (6,3) on it, SIGN (4,3) too
 *   row 5     chair↑ (5,5) faces the kiosk
 *   row 7     plant (2,7)
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import type { FurnitureInteractive } from '../../core/src/furniture/interactive.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

/** A terminal-like kiosk: label + panel, worked at by agents. */
const KIOSK: FurnitureInteractive = {
  agentUse: 'workstation',
  label: {
    name: 'Kiosk',
    lines: [
      { when: ['free'], text: 'Free' },
      { when: ['agentSeated'], text: '{agent} works here' },
    ],
  },
  panel: 'terminal',
};
/** A sign that only says what it is: a label, nothing to click. */
const SIGN: FurnitureInteractive = { label: { name: 'Sign' } };

function asset(
  id: string,
  category: string,
  w: number,
  h: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category,
    width: w * TILE_SIZE,
    height: h * TILE_SIZE,
    footprintW: w,
    footprintH: h,
    isDesk: category === 'desks',
    ...extra,
  };
}

beforeAll(() => {
  const catalog = [
    asset('TABLE', 'desks', 3, 2),
    asset('KIOSK', 'misc', 1, 1, { canPlaceOnSurfaces: true, interactive: KIOSK }),
    asset('SIGN', 'misc', 1, 1, { canPlaceOnSurfaces: true, interactive: SIGN }),
    asset('MUG', 'misc', 1, 1, { canPlaceOnSurfaces: true }),
    asset('PLANT', 'decor', 1, 1),
    asset('CHAIR_BACK', 'chairs', 1, 1, { groupId: 'CHAIR', orientation: 'back' }),
  ];
  const sprites = Object.fromEntries(
    catalog.map((a) => [
      a.id,
      Array.from({ length: a.height }, () => new Array<string>(a.width).fill('opaque')),
    ]),
  ) as Record<string, SpriteData>;
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

const ROOM: PlacedFurniture[] = [
  { uid: 'table', type: 'TABLE', col: 4, row: 3 },
  { uid: 'kiosk', type: 'KIOSK', col: 5, row: 3 },
  { uid: 'sign', type: 'SIGN', col: 4, row: 3 },
  { uid: 'mug', type: 'MUG', col: 6, row: 3 },
  { uid: 'chair', type: 'CHAIR_BACK', col: 5, row: 5 },
  { uid: 'plant', type: 'PLANT', col: 2, row: 7 },
];

function office(): OfficeState {
  const cols = 10;
  const rows = 10;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture: ROOM,
  };
  return new OfficeState(layout);
}

/** The middle of a tile, in world pixels. */
const at = (col: number, row: number) =>
  [col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2] as const;

const OFFICE = { readOnly: false };

describe('the piece under the pointer', () => {
  test('is a declared piece standing on a desk, not the desk under it', () => {
    const os = office();
    assert.equal(os.pieces.at(...at(5, 3), OFFICE), 'kiosk');
    assert.equal(os.pieces.at(...at(4, 3), OFFICE), 'sign');
  });

  test('is nothing over plain furniture: the desk, a mug on it, a plant, a chair', () => {
    const os = office();
    assert.equal(os.pieces.at(...at(5, 4), OFFICE), null); // the table's own tile
    assert.equal(os.pieces.at(...at(6, 3), OFFICE), null); // the mug wins over the table
    assert.equal(os.pieces.at(...at(2, 7), OFFICE), null);
    assert.equal(os.pieces.at(...at(5, 5), OFFICE), null);
    assert.equal(os.pieces.at(...at(8, 8), OFFICE), null); // bare floor
  });

  test('gives way to a character standing in front of it', () => {
    const os = office();
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    const [x, y] = at(5, 3);
    ch.x = x;
    ch.y = y;
    assert.equal(os.getCharacterAt(x, y), 1);
    assert.equal(os.pieces.at(x, y, OFFICE), null);
  });
});

describe('hovering a piece (mouse)', () => {
  test('outlines it, shows its Furniture label from the rules, and offers its click', () => {
    const os = office();
    const view = os.pieces.hoverAt(...at(5, 3), OFFICE);
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    assert.deepEqual(view?.label, { name: 'Kiosk', line: 'Free' });
    assert.deepEqual(view?.click, { kind: 'newPanel', panel: 'terminal', place: null });

    const shown = os.pieces.hovered(OFFICE);
    assert.equal(shown?.uid, 'kiosk');
    assert.deepEqual(shown?.view.label, { name: 'Kiosk', line: 'Free' });
    // Anchored over the piece: its sprite's top edge, centred.
    assert.equal(shown?.anchor.x, 5 * TILE_SIZE + TILE_SIZE / 2);
    assert.equal(shown?.anchor.y, 3 * TILE_SIZE);
  });

  test('a label-only piece shows its label and offers no click', () => {
    const os = office();
    const view = os.pieces.hoverAt(...at(4, 3), OFFICE);
    assert.equal(os.pieces.hoveredUid, 'sign');
    assert.deepEqual(view?.label, { name: 'Sign', line: null });
    assert.equal(view?.click, null);
  });

  test('a read-only office shows the label and offers no click', () => {
    const os = office();
    const view = os.pieces.hoverAt(...at(5, 3), { readOnly: true });
    assert.deepEqual(view?.label, { name: 'Kiosk', line: 'Free' });
    assert.equal(view?.click, null);
  });

  test('moving off it, onto plain furniture, clears it', () => {
    const os = office();
    os.pieces.hoverAt(...at(5, 3), OFFICE);
    assert.equal(os.pieces.hoverAt(...at(2, 7), OFFICE), null);
    assert.equal(os.pieces.hoveredUid, null);
    assert.equal(os.pieces.hovered(OFFICE), null);
  });

  test('a piece with a live shell keeps its label a moment after the mouse leaves: time to reach its ×', () => {
    const os = office();
    os.pieces.setPcShells([{ id: 1_000_000_001, uid: 'kiosk', furnitureType: 'KIOSK_FRONT' }]);
    os.pieces.hoverAt(...at(5, 3), OFFICE, 1000);
    // Off the piece, over bare floor: still hovered, and nothing under the pointer.
    assert.equal(os.pieces.hoverAt(...at(8, 8), OFFICE, 1100), null);
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    // Within the grace it holds; on the label it holds for good; past it, it goes.
    os.pieces.expireHover(1400);
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    os.pieces.holdHover();
    os.pieces.expireHover(9000);
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    os.pieces.releaseHover(9000);
    os.pieces.expireHover(9100);
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    os.pieces.expireHover(9600);
    assert.equal(os.pieces.hoveredUid, null);

    // Onto another piece it moves at once; a view-only office never lingers.
    os.pieces.hoverAt(...at(5, 3), OFFICE, 0);
    os.pieces.hoverAt(...at(4, 3), OFFICE, 10);
    assert.equal(os.pieces.hoveredUid, 'sign');
    os.pieces.hoverAt(...at(5, 3), { readOnly: true }, 20);
    os.pieces.hoverAt(...at(8, 8), { readOnly: true }, 30);
    assert.equal(os.pieces.hoveredUid, null);
  });

  test('the layout editor opening clears it: no outline, no label, and the label hears so', () => {
    const os = office();
    let heard = 0;
    os.pieces.subscribeHover(() => heard++);
    os.pieces.hoverAt(...at(5, 3), OFFICE);
    assert.equal(heard, 1);
    // What OfficeCanvas does as the editor opens (the one place that says so).
    os.pieces.clearHover();
    assert.equal(os.pieces.hoveredUid, null);
    assert.equal(os.pieces.hovered(OFFICE), null);
    assert.equal(heard, 2);
  });

  test("names the agent working there: Nickname, else its character's name, else its Directory", () => {
    const os = office();
    os.pieces.setCharacterName((palette) => (palette === 0 ? 'Byte' : undefined));
    os.addAgent(1, 0, 0, 'chair', true, 'webapp');
    os.setAgentActive(1, true);
    os.pieces.hoverAt(...at(5, 3), OFFICE);
    const line = () => os.pieces.hovered(OFFICE)?.view.label?.line;
    assert.equal(line(), 'Byte works here');
    os.characters.get(1)!.nickname = 'Scout';
    assert.equal(line(), 'Scout works here');
    os.characters.get(1)!.nickname = undefined;
    os.pieces.setCharacterName(() => undefined);
    assert.equal(line(), 'webapp works here');
    assert.deepEqual(os.pieces.hovered(OFFICE)?.view.click, { kind: 'agentTerminal', agentId: 1 });
  });
});

describe("an idle agent's desk", () => {
  test('is still its own: named, not free, off; a click opens a new panel there', () => {
    const os = office();
    os.pieces.setCharacterName((palette) => (palette === 0 ? 'Byte' : undefined));
    os.addAgent(1, 0, 0, 'chair', true, 'webapp');
    os.setAgentActive(1, false);
    os.pieces.hoverAt(...at(5, 3), OFFICE);
    const view = os.pieces.hovered(OFFICE)?.view;
    assert.equal(view?.label?.line, 'Byte works here');
    assert.equal(view?.state, null);
    assert.equal(view?.click?.kind, 'newPanel');
    // Its agent gone, the desk is free again.
    os.removeAgent(1);
    assert.equal(os.pieces.hovered(OFFICE)?.view.label?.line, 'Free');
  });
});

describe('tapping a piece (touch: two steps)', () => {
  const TOUCH = { ...OFFICE, twoStep: true };

  test('the first tap outlines it and shows its label, without clicking', () => {
    const os = office();
    assert.deepEqual(os.pieces.tapAt(...at(5, 3), TOUCH), { uid: 'kiosk', click: null });
    assert.equal(os.pieces.hoveredUid, 'kiosk');
    assert.deepEqual(os.pieces.hovered(OFFICE)?.view.label?.line, 'Free');
  });

  test('a second tap on the same piece performs its click', () => {
    const os = office();
    os.pieces.tapAt(...at(5, 3), TOUCH);
    assert.deepEqual(os.pieces.tapAt(...at(5, 3), TOUCH), {
      uid: 'kiosk',
      click: { kind: 'newPanel', panel: 'terminal', place: null },
    });
  });

  test('the click takes the label with it: back on the office, the next tap is a first tap again', () => {
    const os = office();
    os.pieces.tapAt(...at(5, 3), TOUCH);
    os.pieces.tapAt(...at(5, 3), TOUCH);
    assert.equal(os.pieces.hoveredUid, null);
    assert.equal(os.pieces.hovered(OFFICE), null);
    assert.deepEqual(os.pieces.tapAt(...at(5, 3), TOUCH), { uid: 'kiosk', click: null });
  });

  test('a tap elsewhere clears it; a tap on another piece moves it there', () => {
    const os = office();
    os.pieces.tapAt(...at(5, 3), TOUCH);
    assert.equal(os.pieces.tapAt(...at(8, 8), TOUCH), null);
    assert.equal(os.pieces.hoveredUid, null);

    os.pieces.tapAt(...at(5, 3), TOUCH);
    assert.deepEqual(os.pieces.tapAt(...at(4, 3), TOUCH), { uid: 'sign', click: null });
    assert.equal(os.pieces.hoveredUid, 'sign');
  });

  test('a second tap on a read-only office, or on a label-only piece, clicks nothing', () => {
    const os = office();
    const readOnly = { ...TOUCH, readOnly: true };
    os.pieces.tapAt(...at(5, 3), readOnly);
    assert.deepEqual(os.pieces.tapAt(...at(5, 3), readOnly), { uid: 'kiosk', click: null });
    os.pieces.tapAt(...at(4, 3), TOUCH);
    assert.deepEqual(os.pieces.tapAt(...at(4, 3), TOUCH), { uid: 'sign', click: null });
  });

  test('a mouse click (one step) clicks at once', () => {
    const os = office();
    assert.deepEqual(os.pieces.tapAt(...at(5, 3), { ...OFFICE, twoStep: false }), {
      uid: 'kiosk',
      click: { kind: 'newPanel', panel: 'terminal', place: null },
    });
  });
});
