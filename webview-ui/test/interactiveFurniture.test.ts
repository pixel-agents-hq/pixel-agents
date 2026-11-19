/**
 * The office runs any furniture's declaration, not the PC's: a kiosk nobody has
 * heard of, declaring the `workstation` agent use and an "on" rule, is sat at and
 * lit exactly as a PC is; an electronics item declaring nothing is plain furniture.
 *
 *   row 3..4  table (4..6, 3..4), KIOSK_FRONT (5,3) and KIOSK_BACK (4,3) on it
 *   row 5     chair↑ (5,5) faces the front kiosk
 *   row 2     chair↓ (4,2) faces the back kiosk (which has no "on" art)
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import type { FurnitureInteractive } from '../../core/src/furniture/interactive.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

const KIOSK: FurnitureInteractive = {
  agentUse: 'workstation',
  states: [{ state: 'on', when: ['agentWorking'] }],
};

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
    width: w * 16,
    height: h * 16,
    footprintW: w,
    footprintH: h,
    isDesk: category === 'desks',
    ...extra,
  };
}

const ON: SpriteData = [['on']];
const PLAIN: SpriteData = [['plain']];
const BACK: SpriteData = [['back']];

beforeAll(() => {
  const kiosk = { groupId: 'KIOSK', canPlaceOnSurfaces: true, interactive: KIOSK };
  const chair = { groupId: 'CHAIR' };
  const catalog = [
    asset('TABLE', 'desks', 3, 2),
    asset('KIOSK_FRONT_OFF', 'misc', 1, 1, { ...kiosk, orientation: 'front', state: 'off' }),
    asset('KIOSK_FRONT_ON', 'misc', 1, 1, { ...kiosk, orientation: 'front', state: 'on' }),
    asset('KIOSK_BACK', 'misc', 1, 1, { ...kiosk, orientation: 'back' }),
    asset('RADIO', 'electronics', 1, 1, { canPlaceOnSurfaces: true }),
    asset('CHAIR_FRONT', 'chairs', 1, 1, { ...chair, orientation: 'front' }),
    asset('CHAIR_BACK', 'chairs', 1, 1, { ...chair, orientation: 'back' }),
  ];
  const sprites = Object.fromEntries(
    catalog.map((a) => [
      a.id,
      a.id === 'KIOSK_FRONT_ON' ? ON : a.id === 'KIOSK_BACK' ? BACK : PLAIN,
    ]),
  );
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

function office(furniture: PlacedFurniture[]): OfficeState {
  const cols = 10;
  const rows = 10;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
  return new OfficeState(layout);
}

const ROOM: PlacedFurniture[] = [
  { uid: 'table', type: 'TABLE', col: 4, row: 3 },
  { uid: 'kiosk', type: 'KIOSK_FRONT_OFF', col: 5, row: 3 },
  { uid: 'kiosk-back', type: 'KIOSK_BACK', col: 4, row: 3 },
  { uid: 'chair', type: 'CHAIR_BACK', col: 5, row: 5 },
  { uid: 'chair-top', type: 'CHAIR_FRONT', col: 4, row: 2 },
];

const lit = (os: OfficeState): boolean => os.furniture.some((f) => f.sprite === ON);

describe('furniture declaring the workstation agent use', () => {
  test('pairs with the seat facing it, whatever its category', () => {
    const os = office(ROOM);
    assert.equal(os.seatWorkstations.get('chair'), 'kiosk');
    assert.equal(os.seatWorkstations.get('chair-top'), 'kiosk-back');
  });

  test('shows its "on" state while its agent works there, and reports the agent', () => {
    const os = office(ROOM);
    os.addAgent(1, 0, 0, 'chair', true);
    os.setAgentActive(1, true);
    assert.equal(lit(os), true);
    assert.equal(os.pieces.facts('kiosk', false).agentAtWork?.id, 1);
    assert.equal(os.pieces.facts('kiosk-back', false).agentAtWork, null);
    os.setAgentActive(1, false);
    assert.equal(lit(os), false);
    assert.equal(os.pieces.facts('kiosk', false).agentAtWork, null);
  });

  test('keeps its usual sprite where it has no art for the state its rule picks', () => {
    const os = office(ROOM);
    os.addAgent(1, 0, 0, 'chair-top', true);
    os.setAgentActive(1, true);
    assert.equal(os.pieces.facts('kiosk-back', false).agentAtWork?.id, 1);
    assert.equal(lit(os), false);
    assert.ok(os.furniture.some((f) => f.sprite === BACK));
  });
});

describe('furniture declaring nothing', () => {
  test('is never a workstation, even in the electronics category', () => {
    const os = office([
      { uid: 'table', type: 'TABLE', col: 4, row: 3 },
      { uid: 'radio', type: 'RADIO', col: 5, row: 3 },
      { uid: 'chair', type: 'CHAIR_BACK', col: 5, row: 5 },
    ]);
    assert.equal(os.seatWorkstations.size, 0);
  });
});
