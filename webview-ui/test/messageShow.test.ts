/**
 * The Message show in the office: `agentMessageShow` applied to OfficeState,
 * as every open office applies it — the sender's character walks to a tile
 * beside each recipient's character in turn, faces it with the gist in its
 * speech bubble while it stands there, then goes back to its desk. What wins
 * against a server Visit, a recipient that leaves, and reduced motion.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import type { AgentMessageShow, AgentVisit } from '../../core/src/messages.js';
import { MESSAGE_SHOW_LINGER_MS } from '../src/constants.js';
import { applyAgentMessageShow, applyAgentVisit } from '../src/office/engine/agentVisit.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

const LINGER_SEC = MESSAGE_SHOW_LINGER_MS / 1000;
const FRAME = 1 / 30;

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
  assert.ok(buildDynamicCatalog({ catalog: [chair], sprites: { TEST_CHAIR: [['c']] } }));
});

/** 10×6 floor; agent 1 (the sender) seated at (1,1), 2 at (8,1), 3 at (8,4). All working. */
function office(): OfficeState {
  const cols = 10;
  const rows = 6;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'a', type: 'TEST_CHAIR', col: 1, row: 1 },
      { uid: 'b', type: 'TEST_CHAIR', col: 8, row: 1 },
      { uid: 'c', type: 'TEST_CHAIR', col: 8, row: 4 },
    ],
  };
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, 'a', true);
  os.addAgent(2, undefined, undefined, 'b', true);
  os.addAgent(3, undefined, undefined, 'c', true);
  // The sender is mid-turn (it called send_message); the recipients work at their desks.
  for (const id of [1, 2, 3]) os.setAgentActive(id, true);
  return os;
}

function show(fromId: number, toIds: number[], gist: string): AgentMessageShow {
  return { type: 'agentMessageShow', fromId, toIds, gist };
}

function visit(id: number, rest: Partial<AgentVisit>): AgentVisit {
  return { type: 'agentVisit', id, ...rest };
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) os.update(FRAME);
}

/** Run until `done` holds (at most `seconds`); fails if it never does. */
function runUntil(os: OfficeState, done: () => boolean, what: string, seconds = 20): void {
  for (let t = 0; t < seconds; t += FRAME) {
    if (done()) return;
    os.update(FRAME);
  }
  assert.fail(`never: ${what}`);
}

function at(os: OfficeState, id: number): { col: number; row: number } {
  const ch = os.characters.get(id)!;
  return { col: ch.tileCol, row: ch.tileRow };
}

/** The way to face from `from` to the orthogonally adjacent `to`. */
function toward(from: { col: number; row: number }, to: { col: number; row: number }): number {
  if (to.col > from.col) return Direction.RIGHT;
  if (to.col < from.col) return Direction.LEFT;
  return to.row > from.row ? Direction.DOWN : Direction.UP;
}

/** Standing beside `recipient`, facing it, with the visit's stop reached. */
function standingBy(os: OfficeState, sender: number, recipient: number): boolean {
  const me = at(os, sender);
  const them = at(os, recipient);
  const ch = os.characters.get(sender)!;
  const adjacent = Math.abs(me.col - them.col) + Math.abs(me.row - them.row) === 1;
  return (
    adjacent &&
    os.visits.stopOf(sender)?.arrived === true &&
    ch.state === CharacterState.IDLE &&
    ch.dir === toward(me, them)
  );
}

test('the sender walks to each recipient in turn, faces it with the gist in its bubble, then goes back to its desk', () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [3, 2], 'Review the parser, please'), { walk: true });

  // On its way: nothing said yet.
  run(os, FRAME * 3);
  assert.equal(os.visits.gistOf(1), null);
  assert.equal(os.characters.get(1)!.state, CharacterState.WALK);

  // First recipient first, though it sits farther away.
  runUntil(os, () => standingBy(os, 1, 3), 'standing by agent 3');
  assert.equal(os.visits.gistOf(1), 'Review the parser, please');
  run(os, LINGER_SEC / 2);
  assert.ok(standingBy(os, 1, 3), 'it lingers there');
  assert.equal(os.visits.gistOf(1), 'Review the parser, please');

  // Then the next one; walking between them, the bubble is gone.
  runUntil(os, () => !os.visits.stopOf(1)?.arrived, 'leaving agent 3');
  assert.equal(os.visits.gistOf(1), null);
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  assert.equal(os.visits.gistOf(1), 'Review the parser, please');

  // Then back to its desk, at work again.
  runUntil(os, () => os.visits.stopOf(1) === null, 'the show to end');
  assert.equal(os.visits.gistOf(1), null);
  runUntil(
    os,
    () => os.characters.get(1)!.state === CharacterState.TYPE,
    'seated at its desk again',
  );
  assert.deepEqual(at(os, 1), { col: 1, row: 1 });
  // The recipients never moved.
  assert.deepEqual(at(os, 2), { col: 8, row: 1 });
  assert.deepEqual(at(os, 3), { col: 8, row: 4 });
});

test('the stop is beside where the recipient is, not where its seat is', () => {
  const os = office();
  os.setAgentActive(2, false);
  assert.ok(os.walkToTile(2, 5, 4));
  runUntil(os, () => at(os, 2).col === 5 && at(os, 2).row === 4, 'agent 2 at (5,4)');
  applyAgentMessageShow(os, show(1, [2], 'Over here'), { walk: true });
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  assert.equal(os.visits.gistOf(1), 'Over here');
});

test('a recipient that leaves, or is not in this office, is skipped; an unknown sender shows nothing', () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [42, 2, 3], 'Heads up'), { walk: true });
  run(os, 0.2);
  os.removeAgent(2);
  runUntil(os, () => standingBy(os, 1, 3), 'standing by agent 3');
  assert.equal(os.visits.gistOf(1), 'Heads up');

  applyAgentMessageShow(os, show(99, [3], 'Ghost'), { walk: true });
  assert.equal(os.visits.gistOf(99), null);
});

test('a second message while the first is shown is walked after it', () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [2], 'First'), { walk: true });
  run(os, 0.2);
  applyAgentMessageShow(os, show(1, [3], 'Second'), { walk: true });
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  assert.equal(os.visits.gistOf(1), 'First');
  runUntil(os, () => standingBy(os, 1, 3), 'standing by agent 3');
  assert.equal(os.visits.gistOf(1), 'Second');
});

test("a server Visit's clear doesn't cut the show; a server Visit arriving mid-show wins", () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [2], 'Still coming'), { walk: true });
  run(os, 0.3);
  // The connect snapshot (or a turn starting) says agent 1 is on no visit.
  applyAgentVisit(os, visit(1, { cleared: true }));
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  assert.equal(os.visits.gistOf(1), 'Still coming');

  applyAgentVisit(os, visit(1, { to: { col: 4, row: 5 }, facing: 'left', stay: true }));
  assert.equal(os.visits.gistOf(1), null, 'the Visit takes over, gist and all');
  runUntil(os, () => at(os, 1).col === 4 && at(os, 1).row === 5, 'at the Visit tile');
  run(os, LINGER_SEC * 2);
  assert.deepEqual(at(os, 1), { col: 4, row: 5 });
  assert.equal(os.characters.get(1)!.dir, Direction.LEFT);
});

test('a show from a character on a Visit goes back to that Visit afterwards, not to its desk', () => {
  const os = office();
  applyAgentVisit(os, visit(1, { to: { col: 4, row: 5 }, facing: 'up', stay: true }));
  runUntil(os, () => os.visits.stopOf(1)?.arrived === true, 'at the Visit tile');
  applyAgentMessageShow(os, show(1, [2], 'Brb'), { walk: true });
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  runUntil(
    os,
    () => at(os, 1).col === 4 && at(os, 1).row === 5 && os.visits.stopOf(1)?.arrived === true,
    'back at the Visit tile',
  );
  assert.equal(os.characters.get(1)!.dir, Direction.UP);
  assert.equal(os.visits.gistOf(1), null);
  // Its clear still ends it then.
  applyAgentVisit(os, visit(1, { cleared: true }));
  assert.equal(os.visits.stopOf(1), null);
});

test('without walking (reduced motion), or with no one to walk to, the gist shows over the character where it is', () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [2, 3], 'Quietly'), { walk: false });
  assert.equal(os.visits.gistOf(1), 'Quietly');
  run(os, LINGER_SEC - 0.5);
  assert.deepEqual(at(os, 1), { col: 1, row: 1 });
  assert.equal(os.characters.get(1)!.state, CharacterState.TYPE);
  assert.equal(os.visits.gistOf(1), 'Quietly');
  run(os, 1);
  assert.equal(os.visits.gistOf(1), null);

  applyAgentMessageShow(os, show(1, [77], 'To nobody here'), { walk: true });
  assert.equal(os.visits.gistOf(1), 'To nobody here');
  assert.equal(os.visits.stopOf(1), null);
});

test('a message arriving while the sender stands by a recipient is walked to its own recipient, not said on the spot', () => {
  const os = office();
  applyAgentMessageShow(os, show(1, [2], 'First'), { walk: true });
  runUntil(os, () => standingBy(os, 1, 2), 'standing by agent 2');
  const there = at(os, 1);
  applyAgentMessageShow(os, show(1, [3], 'Second'), { walk: true });
  runUntil(os, () => os.visits.gistOf(1) === 'Second', 'saying the second gist');
  assert.notDeepEqual(at(os, 1), there, 'it moved on before saying it');
  assert.ok(standingBy(os, 1, 3));
});

test('a show with no one it can reach leaves a character on no visit where it was', () => {
  const os = office();
  os.setAgentActive(1, false);
  assert.ok(os.walkToTile(1, 4, 5));
  runUntil(os, () => at(os, 1).col === 4 && at(os, 1).row === 5, 'at (4,5)');
  os.removeAgent(2);
  run(os, 1); // agent 2 is gone
  applyAgentMessageShow(os, show(1, [2], 'Anyone?'), { walk: true });
  assert.equal(os.visits.stopOf(1), null);
  assert.equal(os.visits.gistOf(1), 'Anyone?');
  run(os, 0.5);
  assert.deepEqual(at(os, 1), { col: 4, row: 5 });
});
