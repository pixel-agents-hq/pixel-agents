/**
 * Unit tests for the task-board errand — the walk an agent makes to the office
 * whiteboard when it publishes a revised task list.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * the same reasoning as greeter.test.ts. This covers the OfficeState DOMAIN
 * MODEL, not UI internals, and the invariants below are ones e2e cannot see
 * without racing a multi-second animation: that the cooldown suppresses a
 * second visit, that an in-flight errand outranks the seat-return the FSM
 * would otherwise force on an active agent, and that the errand clears itself
 * so the agent goes back to work. The visible half (agent walks to the board
 * and comes back) belongs in a Playwright spec.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { TASK_BOARD_DWELL_SEC, TASK_BOARD_VISIT_COOLDOWN_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

/**
 * All-floor layout with a board at (col,row). No catalog is loaded in a unit
 * test, so the board falls back to a 1x1 footprint and its approach tile is the
 * one directly below it.
 */
function boardLayout(boardCol = 4, boardRow = 2, cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [{ uid: 'board-1', type: 'WHITEBOARD', col: boardCol, row: boardRow }],
  };
}

/** Layout with no board at all — the errand must stay inert. */
function boardlessLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** Approach tile for a 1x1 board: directly below it, facing up at it. */
const approachOf = (boardCol: number, boardRow: number) => ({
  col: boardCol,
  row: boardRow + 1,
  dir: Direction.UP,
});

/** Give an agent a seat away from the board. Seats normally derive from chair
 *  furniture through the catalog, which a unit test does not load. */
function giveSeat(os: OfficeState, id: number, col: number, row: number): void {
  const uid = `seat-${id}`;
  os.seats.set(uid, {
    uid,
    seatCol: col,
    seatRow: row,
    facingDir: Direction.DOWN,
    assigned: true,
  });
  os.characters.get(id)!.seatId = uid;
}

/** Run the game loop for `seconds` in fixed 1/60 s steps. */
function advance(os: OfficeState, seconds: number): void {
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) os.update(step);
}

/**
 * Run the loop until the agent is standing on its errand tile, and stop there.
 *
 * Walking time depends on the grid distance and the walk speed, so advancing a
 * fixed number of seconds either lands mid-walk or overshoots the dwell — and
 * an overshoot is invisible here, because an agent with no seat re-enters TYPE
 * at whatever tile it stands on. Stopping exactly on arrival makes the dwell
 * assertions mean what they say.
 */
function advanceToBoard(os: OfficeState, id: number, maxSeconds = 30): void {
  const step = 1 / 60;
  const ch = os.characters.get(id)!;
  for (let t = 0; t < maxSeconds; t += step) {
    os.update(step);
    if (ch.errandTimer > 0) return; // arrived; the dwell has just begun
  }
  assert.fail(`agent ${id} never reached the board within ${maxSeconds}s`);
}

test('a task revision sends the agent to the board and turns it to face the board', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);

  assert.equal(os.visitTaskBoard(1), true);

  const ch = os.characters.get(1)!;
  assert.deepEqual(ch.errand, approachOf(4, 2), 'errand targets the tile below the board');

  // Walking there takes a moment; the dwell only starts on arrival.
  advanceToBoard(os, 1);
  assert.equal(ch.tileCol, 4);
  assert.equal(ch.tileRow, 3);
  assert.equal(ch.state, CharacterState.TYPE, 'writes on arrival');
  assert.equal(ch.dir, Direction.UP, 'faces the board, not its seat');
});

test('the errand clears itself after the dwell and the agent leaves the board', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.visitTaskBoard(1);
  const ch = os.characters.get(1)!;

  advanceToBoard(os, 1);
  advance(os, TASK_BOARD_DWELL_SEC / 2);
  assert.notEqual(ch.errand, null, 'still writing part-way through the dwell');

  advance(os, TASK_BOARD_DWELL_SEC);
  assert.equal(ch.errand, null, 'errand released');
  assert.equal(ch.errandTimer, 0);
});

test('an active agent is not dragged back to its seat mid-errand', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);
  // Seats come from chair furniture via the catalog, which a unit test does not
  // load — so the seat is injected directly. Without one this test would pass
  // vacuously: the FSM's repath-to-seat branch is gated on `seatId`, and the
  // guard under test would never be reached.
  giveSeat(os, 1, 8, 6);
  os.setAgentActive(1, true);
  os.visitTaskBoard(1);

  const ch = os.characters.get(1)!;
  assert.equal(ch.seatId, 'seat-1', 'precondition: the agent has a seat to be pulled back to');
  // An active agent with a seat is normally repathed to it every tick. The
  // errand has to outrank that, or the walk to the board never completes.
  advanceToBoard(os, 1);
  assert.equal(ch.tileCol, 4, 'reached the board despite being active');
  assert.equal(ch.tileRow, 3);
  assert.equal(ch.state, CharacterState.TYPE);
});

test('a turn ending mid-visit does not cut the dwell short', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentActive(1, true);
  os.visitTaskBoard(1);
  const ch = os.characters.get(1)!;

  advanceToBoard(os, 1); // arrive and start writing
  assert.equal(ch.state, CharacterState.TYPE);

  os.setAgentActive(1, false); // turn ends while still at the board
  advance(os, TASK_BOARD_DWELL_SEC / 2);
  assert.notEqual(ch.errand, null, 'still writing — the visit is not abandoned');
  assert.equal(ch.tileRow, 3, 'has not wandered off');
});

test('a second revision inside the cooldown does not start another visit', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);

  assert.equal(os.visitTaskBoard(1), true);
  advanceToBoard(os, 1);
  advance(os, TASK_BOARD_DWELL_SEC + 1); // complete the whole visit
  assert.equal(os.characters.get(1)!.errand, null);

  assert.equal(os.visitTaskBoard(1), false, 'suppressed by the cooldown');
  assert.ok(
    TASK_BOARD_VISIT_COOLDOWN_SEC > TASK_BOARD_DWELL_SEC,
    'cooldown must outlast a visit, or it could never suppress one',
  );
});

test('a revision while already walking to the board is ignored', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);

  assert.equal(os.visitTaskBoard(1), true);
  assert.equal(os.visitTaskBoard(1), false, 'no restart while the errand is live');
});

test('an office with no board never sends anyone anywhere', () => {
  const os = new OfficeState(boardlessLayout());
  os.addAgent(1, 0, 0, undefined, true);

  assert.equal(os.visitTaskBoard(1), false);
  assert.equal(os.characters.get(1)!.errand, null);
});

test('two agents writing at once stand on different tiles', () => {
  // A 2-wide board yields two approach tiles, so the second agent must not be
  // sent to the tile the first one already holds.
  const os = new OfficeState({
    version: 1,
    cols: 9,
    rows: 7,
    tiles: new Array<TileType>(9 * 7).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'board-1', type: 'WHITEBOARD', col: 4, row: 2 },
      { uid: 'board-2', type: 'WHITEBOARD', col: 5, row: 2 },
    ],
  });
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 1, 0, undefined, true);

  assert.equal(os.visitTaskBoard(1), true);
  assert.equal(os.visitTaskBoard(2), true);

  const a = os.characters.get(1)!.errand!;
  const b = os.characters.get(2)!.errand!;
  assert.notDeepEqual(a, b, 'the two agents claim different board-side tiles');
});

test('sub-agents have no task list, so they never visit the board', () => {
  const os = new OfficeState(boardLayout());
  os.addAgent(1, 0, 0, undefined, true);
  const subId = os.addSubagent(1, 'tool-1');

  assert.equal(os.visitTaskBoard(subId), false);
  assert.equal(os.characters.get(subId)!.errand, null);
});
