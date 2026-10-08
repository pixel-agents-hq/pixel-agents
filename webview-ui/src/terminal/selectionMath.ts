/**
 * Cell math for the terminal's touch text selection — pure and DOM-free so
 * the Node test runner can pin it (see touchGesture.ts for the gesture that
 * drives it, selectionOverlay.ts for the chrome it positions).
 *
 * All cells are ABSOLUTE buffer cells (row counts from the top of the
 * scrollback, not the viewport), so a selection survives scrolling.
 */

import {
  TERMINAL_COPY_PILL_BELOW_OFFSET_PX,
  TERMINAL_COPY_PILL_BOTTOM_CLEARANCE_PX,
  TERMINAL_COPY_PILL_EDGE_INSET_X_PX,
  TERMINAL_COPY_PILL_GAP_PX,
  TERMINAL_COPY_PILL_MIN_TOP_PX,
  TERMINAL_SEL_HANDLE_KNOB_PX,
  TERMINAL_SEL_HANDLE_WIDTH_PX,
} from '../constants.js';

export interface CellPos {
  row: number;
  col: number;
}

/** A selection, ordered start ≤ end, both ends inclusive. Also the shape of a
 *  drag's anchor (the long-pressed word, or the single pressed cell). */
export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The selection handles' two ends. */
export type HandleEnd = 'start' | 'end';

/** True when cell `a` comes strictly before cell `b` in reading order. */
export function cellBefore(a: CellPos, b: CellPos): boolean {
  return a.row < b.row || (a.row === b.row && a.col < b.col);
}

/** The range spanning `a` and `b`, whichever order they came in. */
export function orderedRange(a: CellPos, b: CellPos): CellRange {
  const [s, e] = cellBefore(b, a) ? [b, a] : [a, b];
  return { startRow: s.row, startCol: s.col, endRow: e.row, endCol: e.col };
}

/** The single-cell range at `cell`. */
export function cellRange(cell: CellPos): CellRange {
  return orderedRange(cell, cell);
}

const rangeStart = (r: CellRange): CellPos => ({ row: r.startRow, col: r.startCol });
const rangeEnd = (r: CellRange): CellPos => ({ row: r.endRow, col: r.endCol });

/**
 * The word under `cell` — the run of non-blank cells around it on its row —
 * or null when the cell itself is blank. `isBlank` reads the buffer.
 */
export function wordRangeAt(
  cell: CellPos,
  cols: number,
  isBlank: (cell: CellPos) => boolean,
): CellRange | null {
  const { row } = cell;
  if (isBlank(cell)) return null;
  let start = cell.col;
  let end = cell.col;
  while (start > 0 && !isBlank({ row, col: start - 1 })) start--;
  while (end < cols - 1 && !isBlank({ row, col: end + 1 })) end++;
  return { startRow: row, startCol: start, endRow: row, endCol: end };
}

/**
 * Dragging on after a long-press: the selection grows from the anchor toward
 * the finger. A finger before the anchor's start selects back to the anchor's
 * end (the whole anchor word stays selected); anywhere else selects from the
 * anchor's start to the finger.
 */
export function extendFromAnchor(anchor: CellRange, to: CellPos): CellRange {
  return cellBefore(to, rangeStart(anchor))
    ? orderedRange(to, rangeEnd(anchor))
    : orderedRange(rangeStart(anchor), to);
}

/**
 * Dragging one selection handle to `to`: that end follows the finger, clamped
 * at the other end so at least one cell stays selected (the ends never swap).
 */
export function dragHandle(range: CellRange, end: HandleEnd, to: CellPos): CellRange {
  if (end === 'start') {
    const past = cellBefore(rangeEnd(range), to);
    const s = past ? rangeEnd(range) : to;
    return { ...range, startRow: s.row, startCol: s.col };
  }
  const past = cellBefore(to, rangeStart(range));
  const e = past ? rangeStart(range) : to;
  return { ...range, endRow: e.row, endCol: e.col };
}

/** term.select() takes a start cell plus a length that wraps across rows. */
export function selectionLength(range: CellRange, cols: number): number {
  return (range.endRow - range.startRow) * cols + (range.endCol - range.startCol) + 1;
}

/** The slice of a DOMRect the geometry reads. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The absolute buffer cell under client point (x, y) of the cell grid
 *  `screen` (the .xterm-screen rect), clamped into the grid. */
export function cellFromPoint(
  screen: RectLike,
  cols: number,
  rows: number,
  viewportY: number,
  x: number,
  y: number,
): CellPos {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const col = clamp(Math.floor(((x - screen.left) / screen.width) * cols), cols - 1);
  const vpRow = clamp(Math.floor(((y - screen.top) / screen.height) * rows), rows - 1);
  return { col, row: viewportY + vpRow };
}

/** Pixel geometry of the cell grid relative to the pane's host element —
 *  shared by the copy pill and the selection handles. */
export interface CellGrid {
  hostWidth: number;
  hostHeight: number;
  cellHeight: number;
  /** Left edge of column `col`, host-relative. */
  x: (col: number) => number;
  /** Top edge of absolute buffer row `row`, host-relative. */
  y: (row: number) => number;
}

export function cellGrid(
  screen: RectLike,
  host: RectLike,
  cols: number,
  rows: number,
  viewportY: number,
): CellGrid {
  const cellHeight = screen.height / rows;
  return {
    hostWidth: host.width,
    hostHeight: host.height,
    cellHeight,
    x: (col) => screen.left - host.left + (screen.width / cols) * col,
    y: (row) => screen.top - host.top + (row - viewportY) * cellHeight,
  };
}

export interface PixelPos {
  left: number;
  top: number;
}

/**
 * Where the copy pill's top-center goes: centered above the whole selection
 * so it never covers the selected text (a multi-row selection spans the full
 * width, so center on the pane); when the top row leaves no room, it drops
 * below the end handle instead. Clamped inside the host.
 */
export function copyPillPosition(range: CellRange, grid: CellGrid): PixelPos {
  const cx =
    range.startRow === range.endRow
      ? (grid.x(range.startCol) + grid.x(range.endCol + 1)) / 2
      : grid.hostWidth / 2;
  const above = grid.y(range.startRow) - TERMINAL_COPY_PILL_GAP_PX;
  const top =
    above >= TERMINAL_COPY_PILL_MIN_TOP_PX
      ? above
      : grid.y(range.endRow + 1) + TERMINAL_COPY_PILL_BELOW_OFFSET_PX;
  return {
    left: Math.min(
      grid.hostWidth - TERMINAL_COPY_PILL_EDGE_INSET_X_PX,
      Math.max(TERMINAL_COPY_PILL_EDGE_INSET_X_PX, cx),
    ),
    top: Math.min(
      grid.hostHeight - TERMINAL_COPY_PILL_BOTTOM_CLEARANCE_PX,
      Math.max(TERMINAL_COPY_PILL_MIN_TOP_PX, top),
    ),
  };
}

/**
 * Where each handle's wrapper goes. Bars sit flush with the selection's
 * outer edges; the wrapper offsets center its touch strip on that edge (and
 * lift the start handle by its knob, which caps the bar from above).
 */
export function handlePositions(range: CellRange, grid: CellGrid): Record<HandleEnd, PixelPos> {
  const halfWidth = TERMINAL_SEL_HANDLE_WIDTH_PX / 2;
  return {
    start: {
      left: grid.x(range.startCol) - halfWidth,
      top: grid.y(range.startRow) - TERMINAL_SEL_HANDLE_KNOB_PX,
    },
    end: { left: grid.x(range.endCol + 1) - halfWidth, top: grid.y(range.endRow) },
  };
}
