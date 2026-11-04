/**
 * The launch button's two menus as one pure state (useRosterLaunch drives it):
 * which menu is open (never both) and the roster pick the drawer is asking a
 * Directory for. DOM- and React-free, so the rules are Node-tested.
 */

/** Which of the launch button's two menus is open: never both. */
export type LaunchMenu = 'none' | 'drawer' | 'roster';

export interface LaunchMenusState {
  menu: LaunchMenu;
  /**
   * The roster pick the drawer was opened for (the character's permanent
   * profile id, not its index: another office's save can renumber the cast
   * while the drawer is open), or null. It outlives the drawer's closing, so
   * the closing drawer keeps its "Launch X in" heading through its pop-out;
   * the drawer's next opening replaces it (a pick) or drops it (the launch
   * button).
   */
  pick: string | null;
}

export const LAUNCH_MENUS_CLOSED: LaunchMenusState = { menu: 'none', pick: null };

export type LaunchMenusAction =
  /** The launch button (both shells): the plain drawer, any pick dropped. */
  | { type: 'openDrawer' }
  /** A roster pick: the drawer, asking where to launch that character. */
  | { type: 'pick'; id: string }
  /** The picked character left the cast: drop the pick, and the drawer asking for it. */
  | { type: 'dropPick' }
  | { type: 'openRoster' }
  | { type: 'toggleRoster' }
  /** Shut `which` if it is the open one; the other menu is left alone. */
  | { type: 'close'; which: Exclude<LaunchMenu, 'none'> };

/** `menu` open instead, the pick kept (see `pick`). */
const show = (state: LaunchMenusState, menu: LaunchMenu): LaunchMenusState =>
  menu === state.menu ? state : { ...state, menu };

export function launchMenusReducer(
  state: LaunchMenusState,
  action: LaunchMenusAction,
): LaunchMenusState {
  switch (action.type) {
    case 'openDrawer':
      return state.menu === 'drawer' && state.pick === null
        ? state
        : { menu: 'drawer', pick: null };
    case 'pick':
      return { menu: 'drawer', pick: action.id };
    case 'dropPick':
      return state.pick === null
        ? state
        : { menu: state.menu === 'drawer' ? 'none' : state.menu, pick: null };
    case 'openRoster':
      return show(state, 'roster');
    case 'toggleRoster':
      return show(state, state.menu === 'roster' ? 'none' : 'roster');
    case 'close':
      return state.menu === action.which ? show(state, 'none') : state;
  }
}
