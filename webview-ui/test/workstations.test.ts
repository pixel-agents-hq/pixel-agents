/**
 * Which seat works at which PC, and when that PC turns on.
 *
 * The office is the Red Room of a real layout that showed two bugs: agents
 * spawned on the sofa above the meeting table (its seats "faced" PCs two and
 * three tiles away, across the table's top chair), and an agent in a side
 * chair turned on the front PC meant for the bottom chair (the scan reached
 * it diagonally, and only front PCs have an "on" sprite).
 *
 *   row 1   sofa (3,1)(4,1)          sofa (6,1)(7,1)       — face down, no desk in front
 *   row 3            chair↓ (5,3)  PC_BACK (5,3)
 *   row 4..6   table (4..6, 3..6), PC_SIDE (4,4), PC_SIDE:left (6,4), PC_FRONT (5,5)
 *   row 5   chair→ (3,5)                     chair← (7,5)
 *   row 7            chair↑ (5,7)
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import { layoutToSeats } from '../src/office/layout/layoutSerializer.js';
import { pairWorkstations } from '../src/office/layout/workstations.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

function asset(
  id: string,
  category: string,
  footprintW: number,
  footprintH: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category,
    width: footprintW * 16,
    height: footprintH * 16,
    footprintW,
    footprintH,
    isDesk: category === 'desks',
    ...extra,
  };
}

const OFF_SPRITE: SpriteData = [['off']];
const ON_SPRITE: SpriteData = [['on']];

beforeAll(() => {
  const pc = { groupId: 'PC', canPlaceOnSurfaces: true, backgroundTiles: 1 };
  const chair = { groupId: 'CUSHIONED_CHAIR' };
  const catalog = [
    asset('TABLE_FRONT', 'desks', 3, 4, { backgroundTiles: 1 }),
    asset('PC_FRONT_ON_1', 'electronics', 1, 2, { ...pc, orientation: 'front', state: 'on' }),
    asset('PC_FRONT_OFF', 'electronics', 1, 2, { ...pc, orientation: 'front', state: 'off' }),
    asset('PC_BACK', 'electronics', 1, 2, { ...pc, orientation: 'back' }),
    asset('PC_SIDE', 'electronics', 1, 2, { ...pc, orientation: 'side', mirrorSide: true }),
    asset('CUSHIONED_CHAIR_FRONT', 'chairs', 1, 1, { ...chair, orientation: 'front' }),
    asset('CUSHIONED_CHAIR_BACK', 'chairs', 1, 1, { ...chair, orientation: 'back' }),
    asset('CUSHIONED_CHAIR_SIDE', 'chairs', 1, 1, {
      ...chair,
      orientation: 'side',
      mirrorSide: true,
    }),
    asset('SOFA_FRONT', 'chairs', 2, 1, { groupId: 'SOFA', orientation: 'front' }),
  ];
  const sprites = Object.fromEntries(
    catalog.map((a) => [a.id, a.id === 'PC_FRONT_ON_1' ? ON_SPRITE : OFF_SPRITE]),
  );
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

const RED_ROOM: PlacedFurniture[] = [
  { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 3 },
  { uid: 'pc-left', type: 'PC_SIDE', col: 4, row: 4 },
  { uid: 'pc-right', type: 'PC_SIDE:left', col: 6, row: 4 },
  { uid: 'pc-bottom', type: 'PC_FRONT_OFF', col: 5, row: 5 },
  { uid: 'pc-top', type: 'PC_BACK', col: 5, row: 3 },
  { uid: 'chair-left', type: 'CUSHIONED_CHAIR_SIDE', col: 3, row: 5 },
  { uid: 'chair-right', type: 'CUSHIONED_CHAIR_SIDE:left', col: 7, row: 5 },
  { uid: 'chair-bottom', type: 'CUSHIONED_CHAIR_BACK', col: 5, row: 7 },
  { uid: 'chair-top', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 3 },
  { uid: 'sofa-a', type: 'SOFA_FRONT', col: 3, row: 1 },
  { uid: 'sofa-b', type: 'SOFA_FRONT', col: 6, row: 1 },
];

function layout(furniture: PlacedFurniture[]): OfficeLayout {
  const cols = 10;
  const rows = 10;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

function pairs(furniture: PlacedFurniture[]): Record<string, string> {
  return Object.fromEntries(pairWorkstations(layoutToSeats(furniture), furniture, getCatalogEntry));
}

describe('pairWorkstations', () => {
  test('each chair gets the PC whose screen faces it; sofas get none', () => {
    assert.deepEqual(pairs(RED_ROOM), {
      'chair-left': 'pc-left',
      'chair-right': 'pc-right',
      'chair-bottom': 'pc-bottom',
      'chair-top': 'pc-top',
    });
  });

  test('a PC is never shared: the closer of two facing seats owns it', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 3 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 5, row: 5 },
      { uid: 'near', type: 'CUSHIONED_CHAIR_BACK', col: 5, row: 7 },
      { uid: 'diagonal', type: 'CUSHIONED_CHAIR_BACK', col: 4, row: 7 },
    ];
    assert.deepEqual(pairs(furniture), { near: 'pc' });
  });

  test('a PC whose screen faces away belongs to nobody', () => {
    const furniture: PlacedFurniture[] = [
      { uid: 'table', type: 'TABLE_FRONT', col: 4, row: 3 },
      { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 4 },
      { uid: 'chair', type: 'CUSHIONED_CHAIR_SIDE', col: 3, row: 5 },
    ];
    assert.deepEqual(pairs(furniture), {});
  });
});

describe('a PC turns on only while its own seat is worked at', () => {
  // Only the front PC (pc-bottom) has an "on" sprite, so "anything lit" means it.
  const bottomPcOn = (office: OfficeState): boolean =>
    office.furniture.some((f) => f.sprite[0]?.[0] === ON_SPRITE[0][0]);

  test('new agents are seated at a chair with a PC, never on the sofa', () => {
    for (let i = 0; i < 40; i++) {
      const office = new OfficeState(layout(RED_ROOM));
      office.addAgent(1, 0, 0, undefined, true);
      const seat = office.characters.get(1)!.seatId!;
      assert.ok(office.seatWorkstations.has(seat), `seated on ${seat}`);
    }
  });

  test('working at the side chair leaves the front PC off', () => {
    const office = new OfficeState(layout(RED_ROOM));
    office.addAgent(1, 0, 0, 'chair-left', true);
    office.setAgentActive(1, true);
    assert.equal(bottomPcOn(office), false);
  });

  test('working at the bottom chair turns its front PC on, and off when the turn ends', () => {
    const office = new OfficeState(layout(RED_ROOM));
    office.addAgent(1, 0, 0, 'chair-bottom', true);
    office.setAgentActive(1, true);
    assert.equal(bottomPcOn(office), true);
    office.setAgentActive(1, false);
    assert.equal(bottomPcOn(office), false);
  });

  test('an active agent that is not sitting in its seat leaves the PC off', () => {
    const office = new OfficeState(layout(RED_ROOM));
    office.addAgent(1, 0, 0, 'chair-bottom', true);
    const ch = office.characters.get(1)!;
    ch.tileRow = 8; // standing below the chair, about to walk back to it
    office.setAgentActive(1, true);
    assert.equal(bottomPcOn(office), false);
  });
});
