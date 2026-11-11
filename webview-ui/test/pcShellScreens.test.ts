/**
 * A PC shell in the office: the server's list of live shells (pcShellsLoaded) is
 * the one source of the "panel in use" fact, so a piece with a live shell shows its
 * "on" state, its Furniture label names the shell's Directory (or Home) and its
 * click opens the shell; a list without it (the shell ended, or a reconnect's
 * snapshot no longer lists it) turns it off. A read-only office sees the lit
 * screen but is offered no click.
 *
 *   row 3..4  table (4..6, 3..4), KIOSK_FRONT (5,3) on it
 *   row 5     chair↑ (5,5) faces the kiosk
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import type { FurnitureInteractive } from '../../core/src/furniture/interactive.js';
import type { PcShell } from '../../core/src/messages.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

/** The PC's declaration (its shipped manifest's), on a kiosk nobody has heard of. */
const KIOSK: FurnitureInteractive = {
  agentUse: 'workstation',
  label: {
    name: 'Kiosk',
    lines: [
      { when: ['free'], text: 'Free' },
      { when: ['agentWorking'], text: '{agent} works here' },
      { when: ['panelInUse'], text: 'Shell in {panel}' },
    ],
  },
  panel: 'terminal',
  states: [{ state: 'on', when: ['agentWorking', 'panelInUse'] }],
};

const ON: SpriteData = [['on']];
const PLAIN: SpriteData = [['plain']];

beforeAll(() => {
  const kiosk = { groupId: 'KIOSK', canPlaceOnSurfaces: true, interactive: KIOSK };
  const asset = (id: string, category: string, extra: Partial<CatalogAsset> = {}) => ({
    id,
    label: id,
    category,
    width: TILE_SIZE,
    height: TILE_SIZE,
    footprintW: 1,
    footprintH: 1,
    isDesk: category === 'desks',
    ...extra,
  });
  const catalog: CatalogAsset[] = [
    {
      ...asset('TABLE', 'desks'),
      width: 3 * TILE_SIZE,
      height: 2 * TILE_SIZE,
      footprintW: 3,
      footprintH: 2,
    },
    asset('KIOSK_FRONT_OFF', 'misc', { ...kiosk, orientation: 'front', state: 'off' }),
    asset('KIOSK_FRONT_ON', 'misc', { ...kiosk, orientation: 'front', state: 'on' }),
    asset('CHAIR_BACK', 'chairs', { groupId: 'CHAIR', orientation: 'back' }),
  ];
  const sprites = Object.fromEntries(
    catalog.map((a) => [a.id, a.id === 'KIOSK_FRONT_ON' ? ON : PLAIN]),
  );
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

const ROOM: PlacedFurniture[] = [
  { uid: 'table', type: 'TABLE', col: 4, row: 3 },
  { uid: 'kiosk', type: 'KIOSK_FRONT_OFF', col: 5, row: 3 },
  { uid: 'chair', type: 'CHAIR_BACK', col: 5, row: 5 },
];

function office(): OfficeState {
  const layout: OfficeLayout = {
    version: 1,
    cols: 10,
    rows: 10,
    tiles: new Array(100).fill(TileType.FLOOR_1),
    furniture: ROOM,
  };
  return new OfficeState(layout);
}

const lit = (os: OfficeState): boolean => os.furniture.some((f) => f.sprite === ON);
const view = (os: OfficeState, readOnly = false) => {
  os.hoveredPieceUid = 'kiosk';
  return os.hoveredPiece({ readOnly, editing: false })?.view;
};

const SHELL: PcShell = {
  id: 1_000_000_001,
  uid: 'kiosk',
  furnitureType: 'KIOSK_FRONT_OFF',
  directoryName: 'proj',
};

describe('a PC with a live PC shell', () => {
  test('is lit, says where its shell is, and opens it', () => {
    const os = office();
    assert.equal(lit(os), false);
    os.setPcShells([SHELL]);
    assert.equal(lit(os), true);
    assert.deepEqual(view(os)?.label?.lines, ['Shell in proj']);
    assert.deepEqual(view(os)?.click, { kind: 'openPanel', panel: 'terminal' });
    assert.equal(os.pcShellOf('kiosk')?.id, SHELL.id);
  });

  test('names a shell in the home folder Home', () => {
    const os = office();
    os.setPcShells([{ id: SHELL.id, uid: 'kiosk', furnitureType: 'KIOSK_FRONT_OFF' }]);
    assert.deepEqual(view(os)?.label?.lines, ['Shell in Home']);
  });

  test('turns off once a list leaves its shell out (it ended, or a resync dropped it)', () => {
    const os = office();
    os.setPcShells([SHELL]);
    os.setPcShells([]);
    assert.equal(lit(os), false);
    assert.equal(os.pcShellOf('kiosk'), null);
    assert.deepEqual(view(os)?.label?.lines, ['Free']);
    assert.deepEqual(view(os)?.click, { kind: 'newPanel', panel: 'terminal' });
  });

  test('stays lit while the agent working there stops, and goes off with the shell', () => {
    const os = office();
    os.addAgent(1, 0, 0, 'chair', true);
    os.setAgentActive(1, true);
    os.setPcShells([SHELL]);
    os.setAgentActive(1, false);
    assert.equal(lit(os), true);
    os.setPcShells([]);
    assert.equal(lit(os), false);
  });

  test('is lit in a read-only office too, which is offered no click', () => {
    const os = office();
    os.setPcShells([SHELL]);
    assert.equal(lit(os), true);
    assert.equal(view(os, true)?.click, null);
  });

  test('lights nothing for a shell whose piece is not in the layout', () => {
    const os = office();
    os.setPcShells([{ ...SHELL, uid: 'gone' }]);
    assert.equal(lit(os), false);
  });
});
