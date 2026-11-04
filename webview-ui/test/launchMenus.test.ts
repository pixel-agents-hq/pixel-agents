/**
 * The launch button's menus: the drawer and the roster, never both, and the
 * roster pick the drawer asks a Directory for.
 */

import { describe, expect, it } from 'vitest';

import type { LaunchMenusAction, LaunchMenusState } from '../src/hooks/launchMenus.js';
import { LAUNCH_MENUS_CLOSED, launchMenusReducer } from '../src/hooks/launchMenus.js';

const run = (...actions: LaunchMenusAction[]): LaunchMenusState =>
  actions.reduce(launchMenusReducer, LAUNCH_MENUS_CLOSED);

describe('launchMenusReducer', () => {
  it('a pick opens the drawer for that character and shuts the roster', () => {
    expect(run({ type: 'openRoster' }, { type: 'pick', id: 'char-3' })).toEqual({
      menu: 'drawer',
      pick: 'char-3',
    });
  });

  it('the launch button drops a pick: the plain drawer, on every shell', () => {
    expect(run({ type: 'pick', id: 'char-3' }, { type: 'openDrawer' })).toEqual({
      menu: 'drawer',
      pick: null,
    });
  });

  it('opening the roster shuts the drawer, and the arrow toggles it', () => {
    expect(run({ type: 'openDrawer' }, { type: 'openRoster' }).menu).toBe('roster');
    expect(run({ type: 'openRoster' }, { type: 'toggleRoster' }).menu).toBe('none');
    expect(run({ type: 'openDrawer' }, { type: 'toggleRoster' }).menu).toBe('roster');
  });

  it('closing one menu leaves the other alone', () => {
    expect(run({ type: 'openRoster' }, { type: 'close', which: 'drawer' }).menu).toBe('roster');
    expect(run({ type: 'openDrawer' }, { type: 'close', which: 'roster' }).menu).toBe('drawer');
  });
});

describe('the pick through the drawer closing', () => {
  it('the closing drawer keeps the pick, so its heading stays through the pop', () => {
    expect(run({ type: 'pick', id: 'char-3' }, { type: 'close', which: 'drawer' })).toEqual({
      menu: 'none',
      pick: 'char-3',
    });
    expect(run({ type: 'pick', id: 'char-3' }, { type: 'openRoster' }).pick).toBe('char-3');
  });

  it('a pick whose character left the cast is dropped, with the drawer asking for it', () => {
    expect(run({ type: 'pick', id: 'char-3' }, { type: 'dropPick' })).toEqual({
      menu: 'none',
      pick: null,
    });
    expect(
      run({ type: 'pick', id: 'char-3' }, { type: 'openRoster' }, { type: 'dropPick' }),
    ).toEqual({ menu: 'roster', pick: null });
  });

  it('the next opening replaces the old pick or drops it', () => {
    const closed = run({ type: 'pick', id: 'char-3' }, { type: 'close', which: 'drawer' });
    expect(launchMenusReducer(closed, { type: 'openDrawer' })).toEqual({
      menu: 'drawer',
      pick: null,
    });
    expect(launchMenusReducer(closed, { type: 'pick', id: 'char-1' })).toEqual({
      menu: 'drawer',
      pick: 'char-1',
    });
  });
});
