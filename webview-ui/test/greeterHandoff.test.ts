/**
 * The greeter becoming the tutorial's agent (OfficeState.handoff): on the
 * tutorial's yes it walks to a free seat and sits, and only then is the Guide's
 * session started; the Guide then takes that seat and the greeter's place,
 * with no spawn effect and no despawn. An OfficeState domain rule (see
 * greeter.test.ts for why these are unit tests); the user-visible half is
 * e2e/tests/standalone/tutorial.spec.ts.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { TUTORIAL_NICKNAME } from '../../core/src/tutorial/quests.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

beforeAll(() => {
  const chair: LoadedAssetData['catalog'][number] = {
    id: 'TEST_CHAIR',
    label: 'chair',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  const sideChair = { ...chair, id: 'TEST_CHAIR_SIDE', orientation: 'right' };
  assert.ok(
    buildDynamicCatalog({
      catalog: [chair, sideChair],
      sprites: { TEST_CHAIR: [['c']], TEST_CHAIR_SIDE: [['c']] },
    }),
  );
});

function layout(chairs: number): OfficeLayout {
  const cols = 9;
  const rows = 7;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: Array.from({ length: chairs }, (_, i) => ({
      uid: `chair${i}`,
      type: 'TEST_CHAIR',
      col: 6 + i,
      row: 1,
    })),
  };
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

/** An office with its greeter up and done materializing. */
function officeWithGreeter(chairs = 1): OfficeState {
  const os = new OfficeState(layout(chairs));
  os.spawnGreeter();
  run(os, 1);
  return os;
}

test('the greeter walks to a free seat, sits, and only then asks for the session there', () => {
  const os = officeWithGreeter();
  const seated: Array<string | undefined> = [];
  os.handoff.begin((seatId) => seated.push(seatId));
  assert.deepEqual(seated, [], 'nothing starts before it sits');
  run(os, 0.3);
  assert.equal(os.greeter!.state, CharacterState.WALK);

  run(os, 15);
  const seat = os.seats.get('chair0')!;
  const greeter = os.greeter!;
  assert.deepEqual(seated, ['chair0'], 'asked once, with its seat (the only one)');
  assert.deepEqual([greeter.tileCol, greeter.tileRow], [seat.seatCol, seat.seatRow]);
  assert.equal(greeter.state, CharacterState.TYPE, 'sitting');
  assert.equal(greeter.dir, seat.facingDir);
  assert.equal(seat.assigned, true, 'its seat is held while the Guide starts');
  assert.equal(os.characters.size, 0, 'still no agent');
});

test("the Guide takes the greeter's seat and place, with no effect either way", () => {
  const os = officeWithGreeter();
  os.handoff.begin(() => {});
  run(os, 15);
  const { x, y } = os.greeter!;

  const seatId = os.handoff.claim(TUTORIAL_NICKNAME);
  assert.equal(seatId, 'chair0');
  os.addAgent(7, 0, 0, seatId!, true);
  os.replaceGreeterWith(7);

  const guide = os.characters.get(7)!;
  assert.equal(os.greeter, null, 'the greeter is gone, not despawning');
  assert.equal(guide.seatId, 'chair0');
  assert.equal(guide.matrixEffect, null, 'no spawn effect');
  assert.deepEqual([guide.x, guide.y], [x, y]);
  assert.equal(guide.state, CharacterState.TYPE);
  assert.equal(os.greeterAnchor(), guide, "the Intro's bubble stays over it");
  os.setAgentActive(7, false); // its first status: no turn under way yet
  run(os, 5);
  assert.equal(guide.state, CharacterState.TYPE, 'idle before its first turn, it stays seated');
  assert.deepEqual([guide.x, guide.y], [x, y]);
  os.despawnGreeter();
  assert.equal(os.greeterAnchor(), null);
  assert.equal(os.characters.has(7), true, 'closing the Intro leaves the Guide');
});

test('only the tutorial agent claims the seat, and only while the hand-off is under way', () => {
  const os = officeWithGreeter();
  assert.equal(os.handoff.claim(TUTORIAL_NICKNAME), null, 'no hand-off yet');
  os.handoff.begin(() => {});
  assert.equal(os.handoff.claim(undefined), null);
  assert.equal(os.handoff.claim('Someone'), null);
  assert.equal(os.handoff.claim(TUTORIAL_NICKNAME), 'chair0');
  assert.equal(os.handoff.claim(TUTORIAL_NICKNAME), null, 'claimed once');
});

test('the greeter takes the nearest free seat, not the first one', () => {
  const os = new OfficeState({
    ...layout(0),
    furniture: [
      { uid: 'far', type: 'TEST_CHAIR', col: 8, row: 0 },
      { uid: 'near', type: 'TEST_CHAIR', col: 2, row: 4 },
    ],
  });
  os.spawnGreeter();
  run(os, 1);
  const seated: Array<string | undefined> = [];
  os.handoff.begin((seatId) => seated.push(seatId));
  run(os, 15);
  assert.deepEqual(seated, ['near']);
});

test('a seat facing sideways wins over a nearer one that does not', () => {
  const os = new OfficeState({
    ...layout(0),
    furniture: [
      { uid: 'near', type: 'TEST_CHAIR', col: 4, row: 4 },
      { uid: 'side', type: 'TEST_CHAIR_SIDE', col: 7, row: 3 },
    ],
  });
  os.spawnGreeter();
  run(os, 1);
  const seated: Array<string | undefined> = [];
  os.handoff.begin((seatId) => seated.push(seatId));
  run(os, 15);
  assert.deepEqual(seated, ['side']);
});

test('another agent launched while the greeter walks does not take its seat', () => {
  const os = officeWithGreeter(2);
  os.handoff.begin(() => {});
  const held = [...os.seats.values()].find((seat) => seat.assigned)!;
  os.addAgent(3);
  assert.notEqual(os.characters.get(3)!.seatId, held.uid);
});

test('with no free seat it starts at once, without a seat; closing the Intro frees a held one', () => {
  const none = officeWithGreeter(0);
  const seated: Array<string | undefined> = [];
  none.handoff.begin((seatId) => seated.push(seatId));
  assert.deepEqual(seated, [undefined]);

  const os = officeWithGreeter();
  os.handoff.begin(() => {});
  assert.equal(os.seats.get('chair0')!.assigned, true);
  os.despawnGreeter();
  assert.equal(os.seats.get('chair0')!.assigned, false);
  assert.equal(os.handoff.claim(TUTORIAL_NICKNAME), null);
});
