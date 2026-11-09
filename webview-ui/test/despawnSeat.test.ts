/**
 * A departing agent's seat stays free across a layout rebuild.
 *
 * Closing an agent frees its seat at once and plays a short despawn effect,
 * during which the character is still in the office. A layout rebuild in that
 * window (a reconnect after a server restart closes the old agents and then
 * reloads the layout) used to re-seat every character on the map — the
 * departing one included — so it took its old seat back, vanished, and left
 * the seat marked taken for good.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

beforeAll(() => {
  const chair: CatalogAsset = {
    id: 'TEST_CHAIR',
    label: 'chair',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  assert.ok(buildDynamicCatalog({ catalog: [chair], sprites: { TEST_CHAIR: [['c']] } }));
});

function layoutWithChairs(): OfficeLayout {
  const cols = 8;
  const rows = 6;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'a', type: 'TEST_CHAIR', col: 1, row: 1 },
      { uid: 'b', type: 'TEST_CHAIR', col: 4, row: 1 },
    ],
  };
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

test('a layout rebuild during a despawn does not hand the departing agent its seat back', () => {
  const layout = layoutWithChairs();
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, 'a', true);
  assert.equal(os.seats.get('a')!.assigned, true);

  os.removeAgent(1);
  os.rebuildFromLayout(layout);
  run(os, 1); // the despawn effect finishes

  assert.equal(os.characters.has(1), false);
  assert.equal(os.seats.get('a')!.assigned, false);
});

test('a new agent can take the seat a departing agent left', () => {
  const layout = layoutWithChairs();
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, 'a', true);
  os.addAgent(2, undefined, undefined, 'b', true);

  os.removeAgent(1);
  os.rebuildFromLayout(layout);
  run(os, 1);
  os.addAgent(3, undefined, undefined, 'a', true);

  assert.equal(os.characters.get(3)!.seatId, 'a');
});

test('a layout rebuild never seats a helper', () => {
  // Helpers have no chair: they stand by their lead (helperFollow.test.ts).
  // The rebuild's second pass gave every unseated character a free seat,
  // helpers included, so they took the chairs new agents needed.
  const layout = layoutWithChairs();
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, 'a', true);
  const helper = os.addSubagent(1, 'tool-1');

  os.rebuildFromLayout(layout);

  assert.equal(os.characters.get(helper)!.seatId, null);
  assert.equal(os.seats.get('b')!.assigned, false);
});
