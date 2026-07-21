/**
 * Unit tests for the Pet FSM.
 *
 * Covers:
 *   - createPet initial state
 *   - IDLE → WALK transition (wanderTimer expiry + findPath succeeds)
 *   - IDLE → FOLLOW transition (when character nearby and roll succeeds)
 *   - WALK → IDLE on path exhaustion (resets frameTimer)
 *   - FOLLOW → IDLE when target despawns
 *   - FOLLOW → IDLE when duration limit reached
 *   - FOLLOW → IDLE when target reached (Manhattan distance ≤ 1)
 *   - Animation timer increments
 *   - Defensive: empty walkableTiles, etc.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import {
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
} from '../src/constants.js';
import { createPet, updatePet } from '../src/office/engine/petEntity.js';
import type { Character, TileType as TileTypeVal } from '../src/office/types.js';
import { CharacterState, Direction, PetState, TileType } from '../src/office/types.js';

// ── Helpers ────────────────────────────────────────────────────

/** Build an all-FLOOR tile map of given dimensions. */
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

/** Build the walkableTiles index for a fully-open tileMap. */
function buildWalkableTiles(cols: number, rows: number): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c, row: r });
    }
  }
  return tiles;
}

/** Create a minimal Character stub (only fields the FSM reads). */
function makeChar(id: number, col: number, row: number): Character {
  return {
    id,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: col * 16 + 8,
    y: row * 16 + 8,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette: 0,
    hueShift: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: 5,
    isActive: false,
    seatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    inputTokens: 0,
    outputTokens: 0,
  };
}

// Math.random stubbing — single shared mock so we can drive deterministic decisions.
let randomQueue: number[] = [];
const realRandom = Math.random;

beforeEach(() => {
  randomQueue = [];
  Math.random = () => (randomQueue.length > 0 ? randomQueue.shift()! : 0.5);
});

afterEach(() => {
  Math.random = realRandom;
});

// ── createPet ──────────────────────────────────────────────────

test('createPet returns an IDLE pet at the tile center', () => {
  const pet = createPet('p1', 0, 3, 4);
  assert.equal(pet.id, 'p1');
  assert.equal(pet.petType, 0);
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.DOWN);
  assert.equal(pet.x, 3 * 16 + 8);
  assert.equal(pet.y, 4 * 16 + 8);
  assert.equal(pet.tileCol, 3);
  assert.equal(pet.tileRow, 4);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.bubbleType, null);
  assert.equal(pet.bubbleTimer, 0);
  // wanderTimer is randomized within [PET_WANDER_PAUSE_MIN_SEC, MAX]
  assert.ok(pet.wanderTimer > 0);
  assert.ok(pet.wanderTimer <= PET_WANDER_PAUSE_MAX_SEC);
});

// ── IDLE → WALK ───────────────────────────────────────────────

test('IDLE → WALK after wanderTimer expires (follow roll fails)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0.0001;
  // Roll 1: follow check (0.99 > PET_FOLLOW_CHANCE=0.3 → skip follow)
  // Roll 2: pick a random walkable target (Math.floor(0.0 * candidates.length) = first)
  randomQueue = [0.99, 0.0];
  updatePet(pet, 0.1, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.WALK);
  assert.ok(pet.path.length > 0, 'expected non-empty path after IDLE→WALK');
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.frame, 0);
  assert.equal(pet.frameTimer, 0);
});

test('IDLE stays IDLE when wanderTimer > 0', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.wanderTimer = 10;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.ok(pet.wanderTimer < 10, 'wanderTimer should decrement by dt');
});

test('IDLE stays IDLE when walkableTiles is empty', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.wanderTimer = 0;
  randomQueue = [0.99]; // skip follow
  updatePet(pet, 0.1, [], new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
});

// ── IDLE → FOLLOW ─────────────────────────────────────────────

test('IDLE → FOLLOW when character is nearby and follow roll succeeds', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(42, 3, 3); // distance 2 (≤ PET_FOLLOW_RADIUS_TILES=3)
  const characters = new Map<number, Character>([[character.id, character]]);
  // Roll 1: follow chance (0.0 < 0.3 → enter follow)
  // Roll 2: followDurationLimit randomRange (0.5 → middle)
  randomQueue = [0.0, 0.5];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, 42);
  assert.equal(pet.followDuration, 0);
  assert.equal(pet.followRecalcTimer, 0);
  assert.ok(
    pet.followDurationLimit > 0 && pet.followDurationLimit <= PET_FOLLOW_DURATION_MAX_SEC,
    'expected followDurationLimit within bounds',
  );
});

test('IDLE does NOT enter FOLLOW when no character is in range', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = createPet('p1', 0, 0, 0);
  pet.wanderTimer = 0;
  const farChar = makeChar(1, 9, 9); // distance 18, beyond radius 3
  const characters = new Map<number, Character>([[1, farChar]]);
  // Roll 1: 0.0 < 0.3 → check for follow target; none found → falls through to WALK
  randomQueue = [0.0, 0.0];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.notEqual(pet.state, PetState.FOLLOW);
});

test('IDLE skips despawning characters as follow targets', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(1, 3, 3);
  character.matrixEffect = 'despawn';
  const characters = new Map<number, Character>([[1, character]]);
  randomQueue = [0.0, 0.0]; // would enter follow if target found
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.notEqual(pet.state, PetState.FOLLOW);
});

// ── WALK → IDLE ───────────────────────────────────────────────

test('WALK → IDLE when path exhausted (resets frameTimer)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.WALK;
  pet.path = []; // already empty → arrival branch
  pet.moveProgress = 0;
  pet.frameTimer = 0.123;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.frameTimer, 0, 'frameTimer must reset to 0 on WALK→IDLE');
  assert.equal(pet.frame, 0);
  assert.ok(pet.wanderTimer > 0);
});

// ── FOLLOW exits ──────────────────────────────────────────────

test('FOLLOW → IDLE when target despawns (no longer in characters map)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 99; // not in map
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.5;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.frameTimer, 0, 'frameTimer reset on FOLLOW→IDLE');
});

test('FOLLOW → IDLE when followDuration >= followDurationLimit', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 1;
  pet.followDuration = 10;
  pet.followDurationLimit = 5;
  pet.frameTimer = 0.7;
  const char = makeChar(1, 4, 4);
  const characters = new Map<number, Character>([[1, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.frameTimer, 0);
});

test('FOLLOW → IDLE when within Manhattan distance 1 of target (faces target)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 7;
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.4;
  // Target is 1 tile to the right → pet faces RIGHT before settling.
  const char = makeChar(7, 3, 2);
  const characters = new Map<number, Character>([[7, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.RIGHT, 'should face target before settling');
  assert.equal(pet.frameTimer, 0);
});

// ── Animation timers ─────────────────────────────────────────

test('WALK animation: frameTimer wraps to 0 and frame increments after PET_WALK_FRAME_DURATION_SEC', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.WALK;
  pet.path = [{ col: 1, row: 0 }]; // 1-tile path so it stays in WALK
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  // Run with dt slightly larger than the animation duration
  updatePet(pet, PET_WALK_FRAME_DURATION_SEC + 0.001, walkable, new Map(), tileMap, new Set());
  // frame should have advanced by 1 (4-step cycle).
  assert.equal(pet.frame, 1);
  // frameTimer should be small positive (the leftover after the threshold)
  assert.ok(pet.frameTimer >= 0 && pet.frameTimer < PET_WALK_FRAME_DURATION_SEC);
});

test('IDLE animation ticks while pet is in IDLE state', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.wanderTimer = 100; // ensures we stay in IDLE, no state transition
  pet.frame = 0;
  pet.frameTimer = 0;
  updatePet(pet, 0.5, walkable, new Map(), tileMap, new Set());
  // frame may or may not have ticked depending on PET_IDLE_FRAME_DURATION_SEC (=0.3)
  // 0.5s > 0.3s → frame increments by 1, frameTimer holds the remainder
  assert.equal(pet.frame, 1);
});

// ── Defensive / edge cases ────────────────────────────────────

test('updatePet does not throw on dt=0', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  assert.doesNotThrow(() => updatePet(pet, 0, walkable, new Map(), tileMap, new Set()));
});

test('updatePet handles FOLLOW with null followTargetId (defensive: never enter follow without setting id)', () => {
  // Synthetic: FOLLOW state with no target id. Should exit cleanly.
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = null;
  pet.followDurationLimit = 5;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE, 'no target → exit FOLLOW');
});
