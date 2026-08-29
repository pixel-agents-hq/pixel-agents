/**
 * Character FSM: idle hangout prefers the cafe / lounge when one exists.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import { SEAT_REST_MIN_SEC } from '../src/constants.js';
import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import type { Seat, TileType as TileTypeVal } from '../src/office/types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../src/office/types.js';

let randomQueue: number[] = [];
const realRandom = Math.random;

beforeEach(() => {
  randomQueue = [];
  Math.random = () => {
    if (randomQueue.length === 0) return 0;
    return randomQueue.shift()!;
  };
});

afterEach(() => {
  Math.random = realRandom;
});

test('idle wander picks a lounge tile when the cafe exists', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const lounge = [{ col: 4, row: 4 }];
  const ch = createIdleCharacter(0, 0);
  ch.wanderTimer = 0;
  // pickWanderTile: Math.floor(0 * 1) → lounge (4,4)
  randomQueue = [0];
  updateCharacter(ch, 0.1, walkable, new Map(), tileMap, new Set(), lounge);
  assert.equal(ch.state, CharacterState.WALK);
  const last = ch.path[ch.path.length - 1];
  assert.deepEqual(last, { col: 4, row: 4 });
});

test('idle wander without a cafe still picks any walkable tile', () => {
  const tileMap = buildOpenTileMap(3, 1);
  const walkable = buildWalkableTiles(3, 1);
  const ch = createIdleCharacter(0, 0);
  ch.wanderTimer = 0;
  // filter out current tile → (1,0) and (2,0); Math.floor(0 * 2) → (1,0)
  randomQueue = [0];
  updateCharacter(ch, 0.1, walkable, new Map(), tileMap, new Set(), []);
  assert.equal(ch.state, CharacterState.WALK);
  const last = ch.path[ch.path.length - 1];
  assert.deepEqual(last, { col: 1, row: 0 });
});

test('idle rest stays in the cafe instead of walking back to the work desk', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const lounge = [{ col: 2, row: 2 }];
  const seats = new Map<string, Seat>([
    [
      'desk-1',
      { uid: 'desk-1', seatCol: 0, seatRow: 0, facingDir: Direction.DOWN, assigned: true },
    ],
  ]);
  const ch = createIdleCharacter(2, 2);
  ch.seatId = 'desk-1';
  ch.wanderTimer = 0;
  ch.wanderCount = 5;
  ch.wanderLimit = 3;
  updateCharacter(ch, 0.1, walkable, seats, tileMap, new Set(), lounge);
  assert.equal(ch.state, CharacterState.IDLE, 'must not walk to the desk');
  assert.equal(ch.tileCol, 2);
  assert.equal(ch.tileRow, 2);
  assert.ok(ch.wanderTimer >= SEAT_REST_MIN_SEC);
  assert.equal(ch.wanderCount, 0);
});

test('idle rest without a cafe still walks back to the assigned desk', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const seats = new Map<string, Seat>([
    [
      'desk-1',
      { uid: 'desk-1', seatCol: 4, seatRow: 4, facingDir: Direction.DOWN, assigned: true },
    ],
  ]);
  const ch = createIdleCharacter(0, 0);
  ch.seatId = 'desk-1';
  ch.wanderTimer = 0;
  ch.wanderCount = 5;
  ch.wanderLimit = 3;
  updateCharacter(ch, 0.1, walkable, seats, tileMap, new Set(), []);
  assert.equal(ch.state, CharacterState.WALK);
  const last = ch.path[ch.path.length - 1];
  assert.deepEqual(last, { col: 4, row: 4 });
});

test('becoming idle at the desk starts a prompt walk toward the cafe', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const lounge = [{ col: 4, row: 4 }];
  const ch = createCharacter(1, 0, 'desk-1', {
    uid: 'desk-1',
    seatCol: 0,
    seatRow: 0,
    facingDir: Direction.DOWN,
    assigned: true,
  });
  ch.isActive = false;
  ch.seatTimer = 0;
  ch.state = CharacterState.TYPE;
  updateCharacter(ch, 0.1, walkable, new Map(), tileMap, new Set(), lounge);
  assert.equal(ch.state, CharacterState.IDLE);
  assert.equal(ch.wanderTimer, 0);
});

test('sub-agents ignore the cafe and wander the full office', () => {
  const tileMap = buildOpenTileMap(3, 1);
  const walkable = buildWalkableTiles(3, 1);
  const lounge = [{ col: 2, row: 0 }];
  const ch = createIdleCharacter(0, 0);
  ch.isSubagent = true;
  ch.wanderTimer = 0;
  // hangout skipped → pool is walkable minus current → (1,0), (2,0); 0 → (1,0)
  randomQueue = [0];
  updateCharacter(ch, 0.1, walkable, new Map(), tileMap, new Set(), lounge);
  assert.equal(ch.state, CharacterState.WALK);
  const last = ch.path[ch.path.length - 1];
  assert.deepEqual(last, { col: 1, row: 0 });
});

function buildOpenTileMap(cols: number, rows: number): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(TileType.FLOOR_1 as TileTypeVal);
    }
    map.push(row);
  }
  return map;
}

function buildWalkableTiles(cols: number, rows: number): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c, row: r });
    }
  }
  return tiles;
}

function createIdleCharacter(col: number, row: number) {
  const ch = createCharacter(1, 0, null, null);
  ch.isActive = false;
  ch.state = CharacterState.IDLE;
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  ch.wanderTimer = 0;
  ch.wanderCount = 0;
  ch.wanderLimit = 5;
  return ch;
}
