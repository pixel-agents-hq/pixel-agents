/**
 * Unit tests for the Greeter — the char_0 character that "speaks" the Intro
 * from near the office's bottom-left corner (IntroBubble is its speech bubble;
 * these tests cover the OfficeState half).
 *
 * The greeter is deliberately NOT an agent: it must stand still (no wander
 * FSM), take no seat (not even across a layout rebuild), and stay invisible to
 * hit-testing so clicks pass through to the office. Spawn/despawn ride the
 * matrix effect, and despawn must be idempotent because every close path of
 * the bubble funnels into it.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * that decision is about UI internals, which community PRs churn. This file
 * tests the OfficeState DOMAIN MODEL — the same thing teammateSeating,
 * petEntity and existingAgents do — and the invariants below are ones e2e
 * cannot observe at all: what is absent from `characters`, what is absent from
 * the persisted seat payload, what a palette-diversity count did not see, and
 * a wander FSM that stays put across five simulated minutes. `consent.spec.ts`
 * covers everything that IS user-visible (greeter appears, greeter despawns).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { GREETER_ID, GREETER_TILE_MARGIN } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';

/** All-floor layout, no furniture — no catalog needed, every tile walkable. */
function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** The greeter's target tile, derived from the margin constant rather than
 *  restated — retuning the margin is a design change, not a broken test. */
function targetTile(rows: number): { col: number; row: number } {
  return { col: GREETER_TILE_MARGIN, row: rows - 1 - GREETER_TILE_MARGIN };
}

test('spawns in from the bottom-left corner, standing, without a seat', () => {
  const os = new OfficeState(floorLayout(9, 9));
  os.spawnGreeter();

  const target = targetTile(9);
  const ch = os.greeter;
  assert.ok(ch, 'greeter exists after spawn');
  assert.equal(ch.isGreeter, true);
  assert.equal(ch.tileCol, target.col, 'margin tiles in from the left edge');
  assert.equal(ch.tileRow, target.row, 'margin tiles up from the bottom edge');
  assert.equal(ch.seatId, null, 'the greeter never takes a seat');
  assert.equal(ch.state, CharacterState.IDLE);
  assert.equal(ch.palette, 0, 'char_0 sprite');
  assert.equal(ch.hueShift, 0);
  assert.equal(ch.matrixEffect, 'spawn', 'materializes with the matrix effect');
});

test('falls back to the closest walkable tile when the target is not walkable', () => {
  // Void out the target tile: the greeter must stand on the nearest walkable
  // tile instead (Manhattan distance 1 on an open floor).
  const layout = floorLayout(9, 9);
  const target = targetTile(9);
  layout.tiles[target.row * 9 + target.col] = TileType.VOID;
  const os = new OfficeState(layout);
  os.spawnGreeter();

  const ch = os.greeter;
  assert.ok(ch, 'greeter exists after spawn');
  assert.notDeepEqual([ch.tileCol, ch.tileRow], [target.col, target.row], 'not on the void tile');
  assert.equal(
    Math.abs(ch.tileCol - target.col) + Math.abs(ch.tileRow - target.row),
    1,
    'on a tile adjacent to the blocked target',
  );
});

test('stands still: minutes of updates never move it or start a walk', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  const ch = os.greeter!;
  const { x, y } = ch;

  // Let the spawn effect finish, then run far past every wander timer.
  for (let i = 0; i < 1200; i++) os.update(0.25); // 5 simulated minutes

  assert.equal(ch.matrixEffect, null, 'spawn effect completed');
  assert.equal(ch.x, x);
  assert.equal(ch.y, y);
  assert.equal(ch.state, CharacterState.IDLE, 'never entered WALK/TYPE');
  assert.equal(ch.path.length, 0);
});

test('spawn is idempotent, and revives a greeter caught mid-despawn', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  os.spawnGreeter();
  assert.equal(
    os.getCharacters().filter((c) => c.isGreeter).length,
    1,
    'double spawn keeps a single greeter',
  );

  // React StrictMode mounts effects twice: despawn (unmount) then respawn.
  // The respawn must cancel the pending removal or the greeter vanishes 0.3s in.
  os.despawnGreeter();
  os.spawnGreeter();
  const ch = os.greeter!;
  assert.equal(ch.matrixEffect, 'spawn', 'despawn flipped back to spawn');
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  assert.ok(os.greeter, 'greeter survived the effect window');
});

test('despawn removes it after the matrix effect, idempotently', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05); // finish spawn effect

  os.despawnGreeter();
  os.despawnGreeter(); // every bubble close path calls this — must not restart
  const ch = os.greeter!;
  assert.equal(ch.matrixEffect, 'despawn');

  os.update(MATRIX_EFFECT_DURATION + 0.05);
  assert.equal(os.greeter, null, 'removed once the effect finished');
});

test('is invisible to hit-testing — clicks pass through', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  const ch = os.greeter!;

  assert.equal(os.getCharacterAt(ch.x, ch.y - 1), null, 'no hit on the greeter sprite');
});

/**
 * The structural invariant the rest of this file rests on: the greeter is not
 * in `characters`, so every consumer that iterates the agent map — seat
 * assignment, palette diversity, hit-testing, and the seat payload the webview
 * persists — excludes it without needing to know it exists. It joins the
 * agents at exactly one seam, `getCharacters()`, which is what the renderer
 * draws.
 */
test('lives outside the agent map, and is drawn anyway', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0);
  os.spawnGreeter();

  assert.equal(os.characters.size, 1, 'the agent map holds the agent alone');
  assert.equal(os.characters.get(GREETER_ID), undefined);
  assert.ok(
    os.getCharacters().some((c) => c.isGreeter),
    'but the render feed includes it',
  );
});

test('never reaches the persisted seat payload', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(7, 0, 0);
  os.spawnGreeter();

  const seats = os.getPersistableSeats();
  assert.deepEqual(Object.keys(seats), ['7'], 'only the real agent is persisted');
  assert.equal(
    GREETER_ID.toString() in seats,
    false,
    'a greeter entry would outlive the ask in ~/.pixel-agents state',
  );
});

test('does not consume a palette slot in diversity counting', () => {
  const os = new OfficeState(floorLayout());
  // char_0 is the greeter's palette. If it counted toward diversity, the first
  // real agent would be steered away from palette 0 by a prop.
  os.spawnGreeter();
  os.addAgent(1, 0, 0);

  assert.equal(
    os.getCharacters().filter((c) => !c.isGreeter && c.palette === 0).length,
    1,
    'the agent keeps palette 0',
  );
});

test('a layout rebuild never seats or repositions the greeter', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  const ch = os.greeter!;
  const { tileCol, tileRow } = ch;

  os.rebuildFromLayout(floorLayout());

  assert.equal(ch.seatId, null, 'still unseated after rebuild');
  assert.equal(ch.tileCol, tileCol);
  assert.equal(ch.tileRow, tileRow);
});

test('greeter camera target: per-frame updates land until a manual pan cancels them', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();

  os.setGreeterCameraTarget({ x: 10, y: 20 });
  assert.deepEqual(os.greeterCameraTarget, { x: 10, y: 20 });

  // Manual pan: target cleared AND later per-frame updates ignored.
  os.cancelGreeterCamera();
  assert.equal(os.greeterCameraTarget, null);
  os.setGreeterCameraTarget({ x: 30, y: 40 });
  assert.equal(os.greeterCameraTarget, null, 'updates stay ignored after cancel');

  // A fresh ask (respawn) re-arms the centering.
  os.despawnGreeter();
  os.spawnGreeter();
  os.setGreeterCameraTarget({ x: 5, y: 6 });
  assert.deepEqual(os.greeterCameraTarget, { x: 5, y: 6 });
});

test('GREETER_ID cannot collide with sub-agent ids', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  const subId = os.addSubagent(1, 'tool-1');
  assert.ok(subId > GREETER_ID, 'sub-agent ids count down from -1, far above the greeter');
  assert.equal(os.greeter!.isGreeter, true);
});
