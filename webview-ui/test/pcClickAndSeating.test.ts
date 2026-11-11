/**
 * Where a click on a PC leads, and where new agents sit round PCs in use, as the
 * office sees it (core's pieceView over the office's facts): a PC with a live PC
 * shell opens it, else the agent working there's terminal, else a new shell — in
 * the one Directory of its Area at once, through the Directory selector when its
 * Area has several, in the home folder with none. Its label says the same, in one
 * line. New agents take a seat at a PC with a live shell only once no other seat is
 * free; a seat given by hand still works, and that PC then opens the shell.
 *
 *   Area "Blue" = columns 0..4, Area "Red" = columns 5..11
 *   row 3..4  table (1..3), kiosk A (2,3)     table (7..9), kiosk B (8,3)
 *   row 5     chair↑ (2,5) faces A            chair↑ (8,5) faces B
 *   row 7                      a plain chair↑ (5,7), no PC
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
      { when: ['panelInUse'], text: 'Shell in {panel}' },
      { when: ['agentWorking'], text: '{agent} works here' },
      { when: ['free'], text: 'Free' },
    ],
  },
  panel: 'terminal',
  states: [{ state: 'on', when: ['agentWorking', 'panelInUse'] }],
};

const SPRITE: SpriteData = [['x']];

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
  assert.ok(
    buildDynamicCatalog({
      catalog,
      sprites: Object.fromEntries(catalog.map((a) => [a.id, SPRITE])),
    }),
  );
});

const COLS = 12;
const ROWS = 9;

function office(furniture: PlacedFurniture[] = ROOM): OfficeState {
  const layout: OfficeLayout = {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles: new Array(COLS * ROWS).fill(TileType.FLOOR_1),
    furniture,
    areaTiles: Array.from({ length: COLS * ROWS }, (_, i) => (i % COLS <= 4 ? 'Blue' : 'Red')),
  };
  const os = new OfficeState(layout);
  os.pieces.setDirectoryNames(['web', 'api', 'docs']);
  return os;
}

const ROOM: PlacedFurniture[] = [
  { uid: 'table-a', type: 'TABLE', col: 1, row: 3 },
  { uid: 'kiosk-a', type: 'KIOSK_FRONT_OFF', col: 2, row: 3 },
  { uid: 'chair-a', type: 'CHAIR_BACK', col: 2, row: 5 },
  { uid: 'table-b', type: 'TABLE', col: 7, row: 3 },
  { uid: 'kiosk-b', type: 'KIOSK_FRONT_OFF', col: 8, row: 3 },
  { uid: 'chair-b', type: 'CHAIR_BACK', col: 8, row: 5 },
  { uid: 'plain', type: 'CHAIR_BACK', col: 5, row: 7 },
];

/** Only kiosk A's table and chair: one seat, at a PC. */
const ONE_DESK = ROOM.filter((f) => f.uid.endsWith('-a'));

const shell = (uid: string, id = 1_000_000_001): PcShell => ({
  id,
  uid,
  furnitureType: 'KIOSK_FRONT_OFF',
  directoryName: 'web',
});

const view = (os: OfficeState, uid = 'kiosk-a') => {
  return os.pieces.view(uid, { readOnly: false }) ?? undefined;
};

const seatOf = (os: OfficeState, id: number) => os.characters.get(id)?.seatId;

describe("a click on a PC: its shell, else its agent's terminal, else a new shell", () => {
  test('a free PC whose Area has several Directories asks which, listing exactly those', () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'], api: ['Blue'], docs: ['Red'] });
    assert.deepEqual(view(os)?.click, {
      kind: 'choosePlace',
      panel: 'terminal',
      places: ['web', 'api'],
    });
  });

  test('one Directory opens there at once; none, or no Area, opens home', () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'], docs: ['Red'] });
    assert.deepEqual(view(os)?.click, { kind: 'newPanel', panel: 'terminal', place: 'web' });
    os.setAreaMappings({ docs: ['Red'] });
    assert.deepEqual(view(os)?.click, { kind: 'newPanel', panel: 'terminal', place: null });

    const unzoned = office();
    delete unzoned.layout.areaTiles;
    unzoned.setAreaMappings({ web: ['Blue'], api: ['Blue'] });
    assert.deepEqual(view(unzoned)?.click, { kind: 'newPanel', panel: 'terminal', place: null });
  });

  test('on touch, the second tap on the PC is the one that asks (the selector)', () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'], api: ['Blue'] });
    const at = [2 * TILE_SIZE + 8, 3 * TILE_SIZE + 8] as const;
    const touch = { readOnly: false, twoStep: true };
    assert.deepEqual(os.pieces.tapAt(...at, touch), { uid: 'kiosk-a', click: null });
    assert.deepEqual(os.pieces.tapAt(...at, touch), {
      uid: 'kiosk-a',
      click: { kind: 'choosePlace', panel: 'terminal', places: ['web', 'api'] },
    });
  });

  test('a mapping naming a Directory the office does not list is not offered', () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'], gone: ['Blue'] });
    assert.deepEqual(view(os)?.click, { kind: 'newPanel', panel: 'terminal', place: 'web' });
  });

  test('an agent at work opens its terminal; with a live shell too, the shell — and the label says so in one line', () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'], api: ['Blue'] });
    os.addAgent(1, 0, 0, 'chair-a', true, 'webapp');
    os.setAgentActive(1, true);
    assert.deepEqual(view(os)?.click, { kind: 'agentTerminal', agentId: 1 });
    assert.equal(view(os)?.label?.line, 'webapp works here');

    os.pieces.setPcShells([shell('kiosk-a')]);
    assert.deepEqual(view(os)?.click, { kind: 'openPanel', panel: 'terminal' });
    assert.deepEqual(view(os)?.label, { name: 'Kiosk', line: 'Shell in web' });
  });
});

describe('seating new agents round PCs with a live shell', () => {
  test('a new agent avoids a PC whose shell lives, for another PC', () => {
    for (let i = 0; i < 20; i++) {
      const os = office();
      os.pieces.setPcShells([shell('kiosk-a')]);
      os.addAgent(1, 0, 0, undefined, true);
      assert.equal(seatOf(os, 1), 'chair-b');
    }
  });

  test('…and for a seat at no PC, when every PC has a live shell', () => {
    const os = office();
    os.pieces.setPcShells([shell('kiosk-a'), shell('kiosk-b', 1_000_000_002)]);
    os.addAgent(1, 0, 0, undefined, true);
    assert.equal(seatOf(os, 1), 'plain');
  });

  test('falls back to it when no other seat is free', () => {
    const os = office(ONE_DESK);
    os.pieces.setPcShells([shell('kiosk-a')]);
    os.addAgent(1, 0, 0, undefined, true);
    assert.equal(seatOf(os, 1), 'chair-a');
  });

  test("a Directory's Area does not outweigh it", () => {
    const os = office();
    os.setAreaMappings({ web: ['Blue'] });
    os.pieces.setPcShells([shell('kiosk-a')]);
    os.addAgent(1, 0, 0, undefined, true, 'web');
    assert.notEqual(seatOf(os, 1), 'chair-a');
  });

  test('a teammate seated beside its lead avoids it too', () => {
    const os = office();
    os.pieces.setPcShells([shell('kiosk-a')]);
    os.addAgent(1, 0, 0, 'plain', true);
    // chair-a and chair-b are both 5 tiles from the lead's seat, chair-a listed first:
    // the shell decides, and the teammate takes chair-b.
    os.addAgent(2, 0, 0, undefined, true, undefined, 1);
    assert.equal(seatOf(os, 2), 'chair-b');
  });

  test('a seat asked for by name, or given by hand, is taken; that PC then opens the shell', () => {
    const asked = office();
    asked.pieces.setPcShells([shell('kiosk-a')]);
    asked.addAgent(1, 0, 0, 'chair-a', true);
    assert.equal(seatOf(asked, 1), 'chair-a');

    const os = office();
    os.pieces.setPcShells([shell('kiosk-a')]);
    os.addAgent(1, 0, 0, undefined, true);
    assert.notEqual(seatOf(os, 1), 'chair-a');
    os.reassignSeat(1, 'chair-a');
    assert.equal(seatOf(os, 1), 'chair-a');
    // Sharing breaks nothing: it works there, and the PC opens the user's shell.
    const ch = os.characters.get(1)!;
    Object.assign(ch, {
      x: 2 * TILE_SIZE + TILE_SIZE / 2,
      y: 5 * TILE_SIZE + TILE_SIZE / 2,
      tileCol: 2,
      tileRow: 5,
      path: [],
    });
    os.setAgentActive(1, true);
    os.update(0.01);
    assert.equal(os.pieces.facts('kiosk-a', false).agentAtWork?.id, 1);
    assert.deepEqual(view(os)?.click, { kind: 'openPanel', panel: 'terminal' });
  });
});
