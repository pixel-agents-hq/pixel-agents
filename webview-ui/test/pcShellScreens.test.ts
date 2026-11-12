/**
 * A PC shell in the office: the server's list of live shells (pcShellsLoaded) is
 * the one source of the "panel in use" fact, so a piece with a live shell shows its
 * "on" state, its Furniture label names the shell's Directory (or Home) and its
 * click opens the shell; a list without it (the shell ended, or a reconnect's
 * snapshot no longer lists it) turns it off. An office that is told of a
 * shell but may not act (read-only rules) is offered no click; a view-only
 * office over /ws is never told of shells at all (server/__tests__/pcShells.test.ts).
 *
 *   row 3..4  table (4..6, 3..4), KIOSK_FRONT (5,3) on it
 *   row 5     chair↑ (5,5) faces the kiosk
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import type { FurnitureInteractive } from '../../core/src/furniture/interactive.js';
import type { PcShell } from '../../core/src/messages.js';
import { type Card, cardOrderOf } from '../src/components/cardBar.js';
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
  return os.pieces.view('kiosk', { readOnly }) ?? undefined;
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
    os.pieces.setPcShells([SHELL]);
    assert.equal(lit(os), true);
    assert.deepEqual(view(os)?.label?.line, 'Shell in proj');
    assert.deepEqual(view(os)?.click, { kind: 'openPanel', panel: 'terminal' });
    assert.equal(os.pieces.shellOf('kiosk')?.id, SHELL.id);
  });

  test('in a view-only office, told only that it is in use: lit, "Busy", no click', () => {
    const os = office();
    os.pieces.setPanelsInUse(['kiosk']);
    assert.equal(lit(os), true);
    assert.deepEqual(view(os, true)?.label?.line, 'Busy');
    assert.equal(view(os, true)?.click, null);
    assert.equal(os.pieces.shellOf('kiosk'), null);
    os.pieces.setPanelsInUse([]);
    assert.equal(lit(os), false);
    assert.deepEqual(view(os, true)?.label?.line, 'Free');
  });

  test('Always Show Labels: the pieces in use are the ones whose labels stay up', () => {
    const os = office();
    assert.deepEqual(os.pieces.inUse({ readOnly: false }), []);
    os.pieces.setPcShells([SHELL, { ...SHELL, id: SHELL.id + 1, uid: 'gone-from-the-layout' }]);
    const shown = os.pieces.inUse({ readOnly: false });
    assert.deepEqual(
      shown.map((p) => [p.uid, p.view.label?.line]),
      [['kiosk', 'Shell in proj']],
    );
    // A view-only office: told only that it is in use.
    const viewOnly = office();
    viewOnly.pieces.setPanelsInUse(['kiosk']);
    assert.deepEqual(
      viewOnly.pieces.inUse({ readOnly: true }).map((p) => p.view.label?.line),
      ['Busy'],
    );
  });

  test('names a shell in the home folder Home', () => {
    const os = office();
    os.pieces.setPcShells([{ id: SHELL.id, uid: 'kiosk', furnitureType: 'KIOSK_FRONT_OFF' }]);
    assert.deepEqual(view(os)?.label?.line, 'Shell in Home');
  });

  test('turns off once a list leaves its shell out (it ended, or a resync dropped it)', () => {
    const os = office();
    os.pieces.setPcShells([SHELL]);
    os.pieces.setPcShells([]);
    assert.equal(lit(os), false);
    assert.equal(os.pieces.shellOf('kiosk'), null);
    assert.deepEqual(view(os)?.label?.line, 'Free');
    assert.deepEqual(view(os)?.click, { kind: 'newPanel', panel: 'terminal', place: null });
  });

  test('stays lit while the agent working there stops, and goes off with the shell', () => {
    const os = office();
    os.addAgent(1, 0, 0, 'chair', true);
    os.setAgentActive(1, true);
    os.pieces.setPcShells([SHELL]);
    os.setAgentActive(1, false);
    assert.equal(lit(os), true);
    os.pieces.setPcShells([]);
    assert.equal(lit(os), false);
  });

  test('is lit in a read-only office too, which is offered no click', () => {
    const os = office();
    os.pieces.setPcShells([SHELL]);
    assert.equal(lit(os), true);
    assert.equal(view(os, true)?.click, null);
  });

  test('lights nothing for a shell whose piece is not in the layout', () => {
    const os = office();
    os.pieces.setPcShells([{ ...SHELL, uid: 'gone' }]);
    assert.equal(lit(os), false);
  });
});

describe('PC shells across a reconnect and layout changes', () => {
  const OTHER: PcShell = { id: SHELL.id + 1, uid: 'kiosk2', furnitureType: 'KIOSK_FRONT_OFF' };
  const twoKiosks = (): OfficeLayout => ({
    version: 1,
    cols: 10,
    rows: 10,
    tiles: new Array(100).fill(TileType.FLOOR_1),
    furniture: [...ROOM, { uid: 'kiosk2', type: 'KIOSK_FRONT_OFF', col: 6, row: 3 }],
  });
  const cardIds = (cards: Card[]): number[] => cards.map((card) => card.id);
  const litCount = (os: OfficeState): number => os.furniture.filter((f) => f.sprite === ON).length;

  test("a reconnect's snapshot is the whole truth: a shell that ended meanwhile loses its card and light", () => {
    const os = new OfficeState(twoKiosks());
    os.addAgent(1, 0, 0, 'chair', true);
    // Resting in its chair: its PC is lit by a shell alone.
    os.setAgentActive(1, false);
    os.pieces.setPcShells([SHELL, OTHER]);
    const saved = [OTHER.id, 1, SHELL.id];
    assert.deepEqual(cardIds(cardOrderOf(saved, [1], new Set(), [SHELL, OTHER])), saved);

    // SHELL ended while the office was away; the snapshot lists OTHER alone.
    const snapshot = [OTHER];
    os.pieces.setPcShells(snapshot);
    assert.equal(os.pieces.shellOf('kiosk'), null);
    assert.equal(litCount(os), 1);
    assert.equal(os.pieces.shellOf('kiosk2')?.id, OTHER.id);
    assert.deepEqual(cardIds(cardOrderOf(saved, [1], new Set(), snapshot)), [OTHER.id, 1]);
  });

  test('a shell whose PC left the layout keeps its card and lights nothing; its PC back, lit again', () => {
    const os = new OfficeState(twoKiosks());
    os.pieces.setPcShells([SHELL, OTHER]);
    const withoutKiosk = {
      ...twoKiosks(),
      furniture: twoKiosks().furniture.filter((f) => f.uid !== 'kiosk'),
    };
    os.rebuildFromLayout(withoutKiosk);
    // Still the office's shell (its card stays), but no piece to light.
    assert.equal(os.pieces.shellOf('kiosk')?.id, SHELL.id);
    // Only the other shell's PC.
    assert.equal(litCount(os), 1);
    assert.deepEqual(cardIds(cardOrderOf([], [], new Set(), [SHELL, OTHER])), [SHELL.id, OTHER.id]);
    // An undo puts the piece back: lit again.
    os.rebuildFromLayout(twoKiosks());
    assert.equal(litCount(os), 2);
  });
});
