/**
 * Unit tests for the reconnect resync's OfficeState half.
 *
 * A dropped socket loses every broadcast sent while it was down; a missed
 * subagentClear left its sub-agent in the office until a reload. On reconnect
 * the webview asks for the snapshot again and takes it as the whole truth:
 * every sub-agent is detached, the replay re-creates the live ones, and the
 * rest stay gone. Live sub-agents must not visibly respawn or jump.
 *
 * Domain-model test like greeter/existingAgents: e2e can't drop a socket
 * mid-session and observe what is absent afterwards.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { staleAgentIds } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

test('a resync drops sub-agents the replay does not re-create', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  const stale = os.addSubagent(1, 'missed-clear');

  os.detachSubagentsForResync();

  assert.equal(os.characters.has(stale), false);
  assert.equal(os.getSubagentId(1, 'missed-clear'), null);
  assert.equal(os.subagentMeta.size, 0);
});

test('a live sub-agent re-created by the replay returns to its spot without a spawn effect', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  const before = os.characters.get(os.addSubagent(1, 'live'))!;
  before.x = 40;
  before.y = 72;
  before.tileCol = 2;
  before.tileRow = 4;

  os.detachSubagentsForResync();
  const after = os.characters.get(os.addSubagent(1, 'live'))!;

  assert.deepEqual([after.x, after.y, after.tileCol, after.tileRow], [40, 72, 2, 4]);
  assert.equal(after.matrixEffect, null);
});

test('a spot is used once: a later spawn under the same key gets a normal entrance', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  os.addSubagent(1, 'live');
  os.detachSubagentsForResync();
  os.addSubagent(1, 'live');
  os.removeSubagent(1, 'live');

  const again = os.characters.get(os.addSubagent(1, 'live'))!;
  assert.equal(again.matrixEffect, 'spawn');
});

test('staleAgentIds: agents the snapshot no longer lists, never sub-agents or the greeter', () => {
  assert.deepEqual(staleAgentIds([1, 2, 3, -1, -1_000_000_000], [1, 3]), [2]);
  assert.deepEqual(staleAgentIds([1, 2], [1, 2]), []);
});

test("syncAgent: a reconnect's snapshot gives a shown agent the server look and seat", () => {
  const os = new OfficeState(floorLayout());
  for (const [uid, col] of [
    ['a', 2],
    ['b', 6],
  ] as const) {
    os.seats.set(uid, { uid, seatCol: col, seatRow: 3, facingDir: 0, assigned: false });
  }
  os.addAgent(1, 7, 90, 'a', true);

  os.syncAgent(1, 2, 0, 'b');

  const ch = os.characters.get(1)!;
  assert.deepEqual([ch.palette, ch.repeat, ch.seatId], [2, 0, 'b']);
  assert.equal(os.seats.get('a')!.assigned, false);
  assert.equal(os.seats.get('b')!.assigned, true);
});

test('syncAgent: never takes a seat someone else sits in', () => {
  const os = new OfficeState(floorLayout());
  os.seats.set('a', { uid: 'a', seatCol: 2, seatRow: 3, facingDir: 0, assigned: false });
  os.seats.set('b', { uid: 'b', seatCol: 6, seatRow: 3, facingDir: 0, assigned: false });
  os.addAgent(1, 0, 0, 'a', true);
  os.addAgent(2, 1, 0, 'b', true);

  os.syncAgent(1, 0, 0, 'b');

  assert.equal(os.characters.get(1)!.seatId, 'a');
  assert.equal(os.characters.get(2)!.seatId, 'b');
});
