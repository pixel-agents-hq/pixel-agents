/**
 * Helpers (sub-agents) stay with their lead.
 *
 * A helper has no chair. It used to wander like an idle agent, then sit down to
 * work wherever the wander had left it — rooms away from its lead. Now it never
 * wanders: it keeps within HELPER_FOLLOW_RADIUS_TILES of its lead, walks back
 * when the lead moves, and sits where it stands while working.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { HELPER_FOLLOW_RADIUS_TILES, HELPER_STAND_UP_DELAY_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../src/office/types.js';

function floorLayout(cols = 20, rows = 12): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

function distance(a: Character, b: Character): number {
  return Math.max(Math.abs(a.tileCol - b.tileCol), Math.abs(a.tileRow - b.tileRow));
}

function teleport(ch: Character, col: number, row: number): void {
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  ch.path = [];
}

function officeWithHelper(): { os: OfficeState; lead: Character; helper: Character } {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  const lead = os.characters.get(1)!;
  teleport(lead, 3, 3);
  const helper = os.characters.get(os.addSubagent(1, 'tool-1'))!;
  return { os, lead, helper };
}

test('an idle helper never wanders away from its lead', () => {
  const { os, lead, helper } = officeWithHelper();
  helper.isActive = false;

  for (let i = 0; i < 12; i++) {
    run(os, 5);
    assert.ok(distance(helper, lead) <= HELPER_FOLLOW_RADIUS_TILES, `drifted at ${i * 5}s`);
  }
});

test('a helper follows its lead to the other side of the office', () => {
  const { os, lead, helper } = officeWithHelper();
  run(os, 1);

  teleport(lead, 16, 9);
  run(os, 10);

  assert.ok(distance(helper, lead) <= HELPER_FOLLOW_RADIUS_TILES);
  assert.ok(distance(helper, lead) > 0, 'never on the lead itself');
});

test('a working helper sits beside its lead, facing it', () => {
  const { os, lead, helper } = officeWithHelper();
  helper.isActive = true;
  teleport(lead, 10, 6);
  run(os, 10);

  assert.equal(helper.state, CharacterState.TYPE);
  assert.ok(distance(helper, lead) <= HELPER_FOLLOW_RADIUS_TILES);
  const dc = lead.tileCol - helper.tileCol;
  const dr = lead.tileRow - helper.tileRow;
  const facing =
    Math.abs(dc) >= Math.abs(dr) ? (dc > 0 ? 'right' : 'left') : dr > 0 ? 'down' : 'up';
  const dirName = ['down', 'left', 'right', 'up'][helper.dir];
  assert.equal(dirName, facing);
});

test('two helpers of one lead settle on different tiles', () => {
  const { os, lead, helper } = officeWithHelper();
  const second = os.characters.get(os.addSubagent(1, 'tool-2'))!;
  teleport(lead, 12, 6);
  run(os, 10);

  assert.notDeepEqual([helper.tileCol, helper.tileRow], [second.tileCol, second.tileRow]);
  assert.ok(distance(second, lead) <= HELPER_FOLLOW_RADIUS_TILES);
});

test("helpers stay around their lead's seat while the lead wanders off", () => {
  const { os, lead, helper } = officeWithHelper();
  os.seats.set('chair', {
    uid: 'chair',
    seatCol: 5,
    seatRow: 5,
    facingDir: Direction.DOWN,
    assigned: true,
  });
  lead.seatId = 'chair';
  lead.isActive = false;
  const seat = { tileCol: 5, tileRow: 5 } as Character;

  teleport(lead, 16, 9);
  lead.state = CharacterState.IDLE;
  lead.wanderTimer = Infinity; // the lead stays where it wandered to
  run(os, 10);

  assert.ok(distance(helper, seat) <= HELPER_FOLLOW_RADIUS_TILES, 'stays at the seat');
  assert.ok(distance(helper, lead) > HELPER_FOLLOW_RADIUS_TILES, 'did not trail the lead');
});

test('a helper stays seated through the short gap between two tool calls', () => {
  const { os, helper } = officeWithHelper();
  helper.isActive = true;
  run(os, 3);
  assert.equal(helper.state, CharacterState.TYPE);
  const dir = helper.dir;

  // One tool call ends and the next starts a moment later: it keeps working.
  os.setAgentActive(helper.id, false);
  run(os, HELPER_STAND_UP_DELAY_SEC / 2);
  assert.equal(helper.state, CharacterState.TYPE, 'did not stand up between tool calls');
  os.setAgentActive(helper.id, true);
  run(os, 1);
  assert.equal(helper.state, CharacterState.TYPE);
  assert.equal(helper.dir, dir);
});

test('a helper stands once it has been waiting a while', () => {
  const { os, helper } = officeWithHelper();
  helper.isActive = true;
  run(os, 3);
  os.setAgentActive(helper.id, false);
  run(os, HELPER_STAND_UP_DELAY_SEC + 0.5);
  assert.equal(helper.state, CharacterState.IDLE);
});

test('helpers surround their lead before any stands two tiles away', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  const lead = os.characters.get(1)!;
  teleport(lead, 8, 6);
  const helpers = Array.from({ length: 8 }, (_, i) =>
    os.characters.get(os.addSubagent(1, `tool-${i}`))!,
  );
  run(os, 5);

  const tiles = new Set(helpers.map((h) => `${h.tileCol},${h.tileRow}`));
  assert.equal(tiles.size, 8);
  for (const h of helpers) assert.equal(distance(h, lead), 1);
});
