/**
 * The launch drawer's row buttons: which buttons a Directory row has, and
 * which row's stack shows beside the drawer. DOM- and React-free, so the rules
 * are Node-tested (LaunchDrawer drives it).
 *
 * A row's buttons are not part of the row: they hang in a small stack outside
 * the drawer's right border, level with the row. A mouse shows a row's stack
 * by hovering it (kept until another row or `+ Directory` is hovered, so the
 * pointer can travel out to it). Touch has no hover, so a long press on the
 * row reveals its stack instead, held until a press anywhere outside the
 * stack; pressing one of its buttons hides it too.
 */

/** One button of a row's stack: the pencil (edit the Directory) and the
 *  worktree button (launch an agent into a new Worktree of its repo). */
export type RowButtonId = 'edit' | 'worktree';

/** The buttons a Directory row offers, in stack order. Only user rows are
 *  editable: a host row is the host's to define. Any row that is a git repo,
 *  host rows included (VS Code's workspace folders, standalone's start
 *  directory), offers a Worktree launch, on both surfaces. */
export function rowButtonsFor(directory: {
  source: 'user' | 'host';
  isRepo?: boolean;
}): RowButtonId[] {
  const buttons: RowButtonId[] = [];
  if (directory.source === 'user') buttons.push('edit');
  if (directory.isRepo === true) buttons.push('worktree');
  return buttons;
}

export interface RowStackState {
  /** The row (its Directory's path) whose stack shows, or null. */
  row: string | null;
  /** Revealed by a long press (touch): held until a press outside the stack,
   *  and shown on coarse pointers, which never show a hovered stack. */
  held: boolean;
}

export const ROW_STACK_HIDDEN: RowStackState = { row: null, held: false };

export type RowStackAction =
  /** The mouse entered (or focus reached) a row; `hasButtons` false = a row
   *  with an empty stack, which hides the shown one. */
  | { type: 'hover'; row: string; hasButtons: boolean }
  /** The mouse moved onto a part of the drawer that is no row (`+ Directory`). */
  | { type: 'hoverNone' }
  /** A touch long press on a row with buttons. */
  | { type: 'longPress'; row: string }
  /** A press anywhere outside the stack. */
  | { type: 'pressOutside' }
  /** One of the stack's buttons was pressed. */
  | { type: 'used' }
  /** The rows scrolled, so the stack would no longer be level with its row. */
  | { type: 'scroll' }
  /** The drawer closed. */
  | { type: 'close' };

const hidden = (state: RowStackState): RowStackState =>
  state.row === null && !state.held ? state : ROW_STACK_HIDDEN;

export function rowStackReducer(state: RowStackState, action: RowStackAction): RowStackState {
  switch (action.type) {
    case 'hover': {
      // A held stack stays put: the mouse events a touch emulates must not
      // move what the long press revealed.
      if (state.held) return state;
      const row = action.hasButtons ? action.row : null;
      return row === state.row ? state : { row, held: false };
    }
    case 'hoverNone':
      return state.held ? state : hidden(state);
    case 'longPress':
      return { row: action.row, held: true };
    case 'pressOutside':
      // Only a held stack waits for a press outside; a hovered one follows the mouse.
      return state.held ? ROW_STACK_HIDDEN : state;
    case 'used':
    case 'scroll':
    case 'close':
      return hidden(state);
  }
}
