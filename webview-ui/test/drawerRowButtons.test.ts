/**
 * The launch drawer's row buttons: which rows have a stack, and which row's
 * stack shows — by hover on desktop, by a long press on touch.
 */

import { describe, expect, it } from 'vitest';

import type { RowStackAction, RowStackState } from '../src/components/drawerRowButtons.js';
import {
  ROW_STACK_HIDDEN,
  rowButtonsFor,
  rowStackReducer,
} from '../src/components/drawerRowButtons.js';

const run = (...actions: RowStackAction[]): RowStackState =>
  actions.reduce(rowStackReducer, ROW_STACK_HIDDEN);

const hover = (row: string, hasButtons = true): RowStackAction => ({
  type: 'hover',
  row,
  hasButtons,
});

describe('rowButtonsFor', () => {
  it('a user row has the pencil; a host row has none', () => {
    expect(rowButtonsFor({ source: 'user', isRepo: false })).toEqual(['edit']);
    expect(rowButtonsFor({ source: 'host', isRepo: false })).toEqual([]);
  });

  it('a git repo row adds the worktree button, host rows included', () => {
    expect(rowButtonsFor({ source: 'user', isRepo: true })).toEqual(['edit', 'worktree']);
    expect(rowButtonsFor({ source: 'host', isRepo: true })).toEqual(['worktree']);
  });
});

describe('rowStackReducer', () => {
  it('hovering a row shows its stack, and it follows the mouse to the next row', () => {
    expect(run(hover('/a'))).toEqual({ row: '/a', held: false });
    expect(run(hover('/a'), hover('/b'))).toEqual({ row: '/b', held: false });
  });

  it('a hovered row with no buttons, or + Directory, hides the stack', () => {
    expect(run(hover('/a'), hover('/host', false))).toEqual(ROW_STACK_HIDDEN);
    expect(run(hover('/a'), { type: 'hoverNone' })).toEqual(ROW_STACK_HIDDEN);
  });

  it('a hovered stack ignores presses outside it (the mouse decides)', () => {
    expect(run(hover('/a'), { type: 'pressOutside' })).toEqual({ row: '/a', held: false });
  });

  it('a long press reveals the row stack and holds it against hover', () => {
    const held = run({ type: 'longPress', row: '/a' });
    expect(held).toEqual({ row: '/a', held: true });
    expect(rowStackReducer(held, hover('/b'))).toBe(held);
    expect(rowStackReducer(held, hover('/host', false))).toBe(held);
    expect(run({ type: 'longPress', row: '/a' }, hover('/b'), { type: 'hoverNone' })).toEqual(held);
  });

  it('a press outside the held stack hides it', () => {
    expect(run({ type: 'longPress', row: '/a' }, { type: 'pressOutside' })).toEqual(
      ROW_STACK_HIDDEN,
    );
  });

  it('a long press on another row moves the held stack there', () => {
    expect(run({ type: 'longPress', row: '/a' }, { type: 'longPress', row: '/b' })).toEqual({
      row: '/b',
      held: true,
    });
  });

  it('pressing a button, scrolling or closing the drawer hides any stack', () => {
    for (const type of ['used', 'scroll', 'close'] as const) {
      expect(run(hover('/a'), { type })).toEqual(ROW_STACK_HIDDEN);
      expect(run({ type: 'longPress', row: '/a' }, { type })).toEqual(ROW_STACK_HIDDEN);
    }
  });

  it('an action that changes nothing returns the same state', () => {
    const state = run(hover('/a'));
    expect(rowStackReducer(state, hover('/a'))).toBe(state);
    expect(rowStackReducer(ROW_STACK_HIDDEN, { type: 'close' })).toBe(ROW_STACK_HIDDEN);
  });
});
