/**
 * Visits in the office: `agentVisit` applied to OfficeState, as every office
 * applies it — the character walks to the tile, faces the way it was told,
 * lingers then wanders, or stays until its agent's next turn; and the
 * multi-stop visits a message show walks (visits.start).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import type { AgentVisit } from '../../core/src/messages.js';
import { VISIT_LINGER_MS } from '../src/constants.js';
import { applyAgentVisit } from '../src/office/engine/agentVisit.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

const LINGER_SEC = VISIT_LINGER_MS / 1000;

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

/** 8×6 floor with a chair at (1,1); col 7 rows 0-1 walled off from (7,0). */
function office(): OfficeState {
  const cols = 8;
  const rows = 6;
  const tiles = new Array<TileType>(cols * rows).fill(TileType.FLOOR_1);
  // (7,0) is floor boxed in by walls at (6,0) and (7,1): no one can walk to it.
  tiles[0 * cols + 6] = TileType.WALL;
  tiles[1 * cols + 7] = TileType.WALL;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [{ uid: 'a', type: 'TEST_CHAIR', col: 1, row: 1 }],
  };
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, 'a', true);
  return os;
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

function visit(id: number, rest: Partial<AgentVisit>): AgentVisit {
  return { type: 'agentVisit', id, ...rest };
}

function at(os: OfficeState, id: number): { col: number; row: number } {
  const ch = os.characters.get(id)!;
  return { col: ch.tileCol, row: ch.tileRow };
}

test('a visit walks the character to the tile and faces it the way it was told, then it lingers and wanders off', () => {
  const os = office();
  os.setAgentActive(1, false);
  applyAgentVisit(os, visit(1, { to: { col: 5, row: 4 }, facing: 'left', stay: false }));
  run(os, 5);
  const ch = os.characters.get(1)!;
  assert.deepEqual(at(os, 1), { col: 5, row: 4 });
  assert.equal(ch.dir, Direction.LEFT);
  assert.equal(ch.state, CharacterState.IDLE);

  // It arrived ~2.3 s in (7 tiles); the linger runs from there.
  run(os, LINGER_SEC - 5);
  assert.deepEqual(at(os, 1), { col: 5, row: 4 }, 'still lingering');
  assert.equal(ch.dir, Direction.LEFT);
  assert.ok(os.visits.stopOf(1)?.arrived);

  run(os, 3);
  assert.equal(os.visits.stopOf(1), null, 'the visit is over');
  // Back to the usual life: it wanders off (or rests in its chair) from here.
  run(os, 120);
  assert.notDeepEqual(at(os, 1), { col: 5, row: 4 });
});

test("the agent's work doesn't pull a visiting character back; once the linger is over a working agent goes to its seat", () => {
  const os = office();
  os.setAgentActive(1, true);
  applyAgentVisit(os, visit(1, { to: { col: 5, row: 4 }, facing: 'up', stay: false }));
  run(os, 5);
  assert.deepEqual(at(os, 1), { col: 5, row: 4 });
  os.setAgentActive(1, true); // another tool of the same turn
  run(os, LINGER_SEC - 6);
  assert.deepEqual(at(os, 1), { col: 5, row: 4 });

  run(os, 10);
  const ch = os.characters.get(1)!;
  assert.deepEqual(at(os, 1), { col: 1, row: 1 }, 'back at its seat');
  assert.equal(ch.state, CharacterState.TYPE);
});

test("stay holds there past the linger until the agent's next turn clears it, which sends it to its seat", () => {
  const os = office();
  os.setAgentActive(1, false);
  applyAgentVisit(os, visit(1, { to: { col: 4, row: 3 }, facing: 'right', stay: true }));
  run(os, LINGER_SEC * 3);
  const ch = os.characters.get(1)!;
  assert.deepEqual(at(os, 1), { col: 4, row: 3 });
  assert.equal(ch.dir, Direction.RIGHT);
  assert.equal(ch.state, CharacterState.IDLE);

  // The next turn: the server says so (cleared) as the agent starts working.
  os.setAgentActive(1, true);
  applyAgentVisit(os, visit(1, { cleared: true }));
  run(os, 5);
  assert.deepEqual(at(os, 1), { col: 1, row: 1 });
  assert.equal(ch.state, CharacterState.TYPE);
  assert.equal(os.visits.stopOf(1), null);
});

test('a cleared visit ends at once for an idle agent, and cleared without a visit changes nothing', () => {
  const os = office();
  os.setAgentActive(1, false);
  applyAgentVisit(os, visit(1, { cleared: true }));
  assert.equal(os.visits.stopOf(1), null);
  applyAgentVisit(os, visit(1, { to: { col: 4, row: 3 }, facing: 'right', stay: true }));
  run(os, 5);
  applyAgentVisit(os, visit(1, { cleared: true }));
  assert.equal(os.visits.stopOf(1), null);
});

test("a reconnect's snapshot re-sending the same visit doesn't restart its linger", () => {
  const os = office();
  os.setAgentActive(1, false);
  const msg = visit(1, { to: { col: 5, row: 4 }, facing: 'left', stay: false });
  applyAgentVisit(os, msg);
  run(os, 5 + LINGER_SEC / 2);
  applyAgentVisit(os, msg);
  run(os, LINGER_SEC / 2 + 1);
  assert.equal(os.visits.stopOf(1), null, 'over on its first schedule');
});

test("a tile this office can't walk to drops the visit; a sub-agent can't be sent", () => {
  const os = office();
  os.setAgentActive(1, false);
  applyAgentVisit(os, visit(1, { to: { col: 7, row: 0 }, facing: 'down', stay: true }));
  run(os, 1);
  assert.equal(os.visits.stopOf(1), null);

  const sub = os.addSubagent(1, 'toolu_x');
  assert.equal(os.visits.start(sub, [{ col: 3, row: 3, dir: Direction.UP }], 'wander'), false);
});

test('a visit of several stops walks them in order, stands at each, then goes back to its seat', () => {
  const os = office();
  os.setAgentActive(1, false);
  const ok = os.visits.start(
    1,
    [
      { col: 4, row: 1, dir: Direction.RIGHT, lingerSec: 5 },
      { col: 4, row: 4, dir: Direction.DOWN, lingerSec: 5 },
    ],
    'seat',
  );
  assert.ok(ok);
  run(os, 3);
  assert.deepEqual(os.visits.stopOf(1), {
    stop: { col: 4, row: 1, dir: Direction.RIGHT, lingerSec: 5 },
    arrived: true,
  });
  assert.equal(os.characters.get(1)!.dir, Direction.RIGHT);
  run(os, 5);
  assert.equal(os.visits.stopOf(1)?.stop.row, 4);
  assert.equal(os.visits.stopOf(1)?.arrived, true);
  assert.equal(os.characters.get(1)!.dir, Direction.DOWN);
  run(os, 8);
  assert.equal(os.visits.stopOf(1), null);
  assert.deepEqual(at(os, 1), { col: 1, row: 1 });
  assert.equal(os.characters.get(1)!.state, CharacterState.TYPE);
});

test('a layout change while visiting keeps the character on its visit, not snapped to its seat', () => {
  const os = office();
  os.setAgentActive(1, false);
  applyAgentVisit(os, visit(1, { to: { col: 5, row: 4 }, facing: 'left', stay: true }));
  run(os, 5);
  os.rebuildFromLayout(os.getLayout());
  run(os, 1);
  assert.deepEqual(at(os, 1), { col: 5, row: 4 });
  assert.equal(os.characters.get(1)!.dir, Direction.LEFT);
});

test("the user's own walk command ends a visit here, and the snapshot re-sending it doesn't start it again", () => {
  const os = office();
  os.setAgentActive(1, false);
  const msg = visit(1, { to: { col: 5, row: 4 }, facing: 'left', stay: true });
  applyAgentVisit(os, msg);
  run(os, 5);
  assert.ok(os.walkToTile(1, 2, 4));
  run(os, 3);
  assert.deepEqual(at(os, 1), { col: 2, row: 4 });
  applyAgentVisit(os, msg); // a reconnect
  assert.equal(os.visits.stopOf(1), null);
  // A new visit (after the server cleared the old one) goes.
  applyAgentVisit(os, visit(1, { cleared: true }));
  applyAgentVisit(os, msg);
  assert.equal(os.visits.stopOf(1)?.stop.col, 5);
});
