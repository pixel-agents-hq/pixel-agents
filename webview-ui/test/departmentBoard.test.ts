/**
 * Unit tests for deriveDepartmentBoard — the pure per-floor roster
 * derivation behind the department board panel.
 *
 * Covers:
 *   - staff is scoped to the given floor (other floors excluded)
 *   - subagents are excluded from staff entirely
 *   - helpWanted only lists agents with bubbleType === 'permission'
 *   - openItems only lists agents with a non-done tool
 *   - an agent can appear in all three lists at once
 *   - statusText matches getAgentActivityText (no drift between overlay and board)
 *   - empty floor / no agentTools entries produce empty lists, not throws
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { deriveDepartmentBoard } from '../src/office/departmentBoard.js';
import type { Character, ToolActivity } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';

function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    id: 1,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: 8,
    y: 8,
    tileCol: 0,
    tileRow: 0,
    path: [],
    moveProgress: 0,
    currentTool: null,
    floorId: 'floor-1',
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
    ...overrides,
  };
}

function charMap(chars: Character[]): Map<number, Character> {
  return new Map(chars.map((c) => [c.id, c]));
}

test('staff is scoped to the given floor', () => {
  const characters = charMap([
    makeChar({ id: 1, floorId: 'floor-1' }),
    makeChar({ id: 2, floorId: 'floor-2' }),
  ]);
  const board = deriveDepartmentBoard(characters, 'floor-1', {});
  assert.deepEqual(
    board.staff.map((e) => e.id),
    [1],
  );
});

test('subagents are excluded from staff', () => {
  const characters = charMap([
    makeChar({ id: 1, isSubagent: false }),
    makeChar({ id: 2, isSubagent: true }),
  ]);
  const board = deriveDepartmentBoard(characters, 'floor-1', {});
  assert.deepEqual(
    board.staff.map((e) => e.id),
    [1],
  );
});

test('helpWanted lists only agents with a permission bubble', () => {
  const characters = charMap([
    makeChar({ id: 1, bubbleType: 'permission' }),
    makeChar({ id: 2, bubbleType: 'waiting', waitingAwaitingInput: true }),
    makeChar({ id: 3, bubbleType: null }),
  ]);
  const board = deriveDepartmentBoard(characters, 'floor-1', {});
  assert.deepEqual(
    board.helpWanted.map((e) => e.id),
    [1],
  );
  assert.deepEqual(
    board.staff.map((e) => e.id),
    [1, 2, 3],
  );
});

test('openItems lists only agents with a non-done tool', () => {
  const tools: Record<number, ToolActivity[]> = {
    1: [{ toolId: 't1', status: 'Running: npm test', done: false, permissionWait: false }],
    2: [{ toolId: 't2', status: 'Running: npm build', done: true, permissionWait: false }],
  };
  const characters = charMap([makeChar({ id: 1 }), makeChar({ id: 2 }), makeChar({ id: 3 })]);
  const board = deriveDepartmentBoard(characters, 'floor-1', tools);
  assert.deepEqual(
    board.openItems.map((e) => e.id),
    [1],
  );
});

test('an agent can appear in staff, helpWanted, and openItems at once', () => {
  const tools: Record<number, ToolActivity[]> = {
    1: [{ toolId: 't1', status: 'Needs approval', done: false, permissionWait: true }],
  };
  const characters = charMap([makeChar({ id: 1, bubbleType: 'permission' })]);
  const board = deriveDepartmentBoard(characters, 'floor-1', tools);
  assert.deepEqual(
    board.staff.map((e) => e.id),
    [1],
  );
  assert.deepEqual(
    board.helpWanted.map((e) => e.id),
    [1],
  );
  assert.deepEqual(
    board.openItems.map((e) => e.id),
    [1],
  );
});

test('statusText matches the same logic ToolOverlay uses (no drift)', () => {
  const tools: Record<number, ToolActivity[]> = {
    1: [{ toolId: 't1', status: 'Running: npm test', done: false, permissionWait: false }],
  };
  const characters = charMap([makeChar({ id: 1, isActive: true })]);
  const board = deriveDepartmentBoard(characters, 'floor-1', tools);
  assert.equal(board.staff[0]?.statusText, 'Running: npm test');
});

test('label falls back to "Agent <id>" when no name or agentName is set', () => {
  const characters = charMap([makeChar({ id: 7 })]);
  const board = deriveDepartmentBoard(characters, 'floor-1', {});
  assert.equal(board.staff[0]?.label, 'Agent 7');
});

test('label prefers name, falls back to agentName', () => {
  const characters = charMap([
    makeChar({ id: 1, name: 'Claudio' }),
    makeChar({ id: 2, agentName: 'web-researcher' }),
  ]);
  const board = deriveDepartmentBoard(characters, 'floor-1', {});
  assert.equal(board.staff.find((e) => e.id === 1)?.label, 'Claudio');
  assert.equal(board.staff.find((e) => e.id === 2)?.label, 'web-researcher');
});

test('empty floor produces empty lists, not a throw', () => {
  const board = deriveDepartmentBoard(new Map(), 'floor-1', {});
  assert.deepEqual(board, { staff: [], helpWanted: [], openItems: [] });
});
