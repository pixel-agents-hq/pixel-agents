/**
 * Cell math behind the terminal's touch text selection. Pure, and the place
 * an off-by-one (a handle that swaps ends, a word that loses its last letter)
 * would hide from review — nothing in e2e drives touch selection.
 */

import { describe, expect, it } from 'vitest';

import {
  cellFromPoint,
  cellGrid,
  copyPillPosition,
  dragHandle,
  extendFromAnchor,
  handlePositions,
  orderedRange,
  selectionLength,
  wordRangeAt,
} from '../src/terminal/selectionMath.js';

/** isBlank over a one-row buffer given as a string. */
const rowText = (text: string) => (c: { row: number; col: number }) => {
  const ch = text[c.col] ?? '';
  return ch === '' || ch === ' ';
};

describe('wordRangeAt', () => {
  const line = 'run  npm test --watch ';
  const cols = line.length;

  it('expands to the run of non-blank cells around the pressed cell', () => {
    // "npm" spans cols 5..7; pressing any of its cells selects all of it.
    for (const col of [5, 6, 7]) {
      expect(wordRangeAt({ row: 3, col }, cols, rowText(line))).toEqual({
        startRow: 3,
        startCol: 5,
        endRow: 3,
        endCol: 7,
      });
    }
  });

  it('stops at the row edges', () => {
    expect(wordRangeAt({ row: 0, col: 1 }, cols, rowText(line))).toMatchObject({
      startCol: 0,
      endCol: 2,
    });
    const full = 'abcdef';
    expect(wordRangeAt({ row: 0, col: 3 }, full.length, rowText(full))).toMatchObject({
      startCol: 0,
      endCol: 5,
    });
  });

  it('treats punctuation as part of the word (blank-delimited, like the original)', () => {
    expect(wordRangeAt({ row: 0, col: 15 }, cols, rowText(line))).toMatchObject({
      startCol: 14,
      endCol: 20,
    });
  });

  it('returns null on a blank cell', () => {
    expect(wordRangeAt({ row: 0, col: 3 }, cols, rowText(line))).toBeNull();
  });
});

describe('orderedRange / extendFromAnchor', () => {
  it('orders two cells into start ≤ end, by row then column', () => {
    const a = { row: 5, col: 2 };
    const b = { row: 3, col: 9 };
    const expected = { startRow: 3, startCol: 9, endRow: 5, endCol: 2 };
    expect(orderedRange(a, b)).toEqual(expected);
    expect(orderedRange(b, a)).toEqual(expected);
    expect(orderedRange({ row: 1, col: 7 }, { row: 1, col: 3 })).toEqual({
      startRow: 1,
      startCol: 3,
      endRow: 1,
      endCol: 7,
    });
  });

  const anchor = { startRow: 10, startCol: 4, endRow: 10, endCol: 8 };

  it('extends forward from the anchor start', () => {
    expect(extendFromAnchor(anchor, { row: 12, col: 0 })).toEqual({
      startRow: 10,
      startCol: 4,
      endRow: 12,
      endCol: 0,
    });
  });

  it('extends backward keeping the whole anchor word selected', () => {
    expect(extendFromAnchor(anchor, { row: 9, col: 6 })).toEqual({
      startRow: 9,
      startCol: 6,
      endRow: 10,
      endCol: 8,
    });
  });

  it('a finger inside the anchor word shrinks the selection to it', () => {
    expect(extendFromAnchor(anchor, { row: 10, col: 6 })).toEqual({
      startRow: 10,
      startCol: 4,
      endRow: 10,
      endCol: 6,
    });
  });
});

describe('dragHandle', () => {
  const range = { startRow: 2, startCol: 5, endRow: 4, endCol: 10 };

  it('moves the dragged end to the finger', () => {
    expect(dragHandle(range, 'start', { row: 1, col: 0 })).toEqual({
      ...range,
      startRow: 1,
      startCol: 0,
    });
    expect(dragHandle(range, 'end', { row: 6, col: 3 })).toEqual({
      ...range,
      endRow: 6,
      endCol: 3,
    });
  });

  it('clamps the start handle at the end (never swaps ends)', () => {
    expect(dragHandle(range, 'start', { row: 9, col: 0 })).toEqual({
      ...range,
      startRow: 4,
      startCol: 10,
    });
    // Exactly onto the end cell is allowed — one cell stays selected.
    expect(dragHandle(range, 'start', { row: 4, col: 10 })).toEqual({
      ...range,
      startRow: 4,
      startCol: 10,
    });
  });

  it('clamps the end handle at the start', () => {
    expect(dragHandle(range, 'end', { row: 2, col: 1 })).toEqual({
      ...range,
      endRow: 2,
      endCol: 5,
    });
    expect(dragHandle(range, 'end', { row: 0, col: 30 })).toEqual({
      ...range,
      endRow: 2,
      endCol: 5,
    });
  });
});

describe('selectionLength', () => {
  it('counts cells across wrapped rows, both ends inclusive', () => {
    expect(selectionLength({ startRow: 3, startCol: 2, endRow: 3, endCol: 2 }, 80)).toBe(1);
    expect(selectionLength({ startRow: 3, startCol: 2, endRow: 3, endCol: 6 }, 80)).toBe(5);
    expect(selectionLength({ startRow: 3, startCol: 78, endRow: 4, endCol: 1 }, 80)).toBe(4);
  });
});

describe('cellFromPoint', () => {
  const screen = { left: 10, top: 20, width: 800, height: 400 }; // 80x20 cells of 10x20

  it('maps a client point to an absolute buffer cell', () => {
    expect(cellFromPoint(screen, 80, 20, 100, 10 + 35, 20 + 45)).toEqual({ col: 3, row: 102 });
  });

  it('clamps points outside the grid onto its edge cells', () => {
    expect(cellFromPoint(screen, 80, 20, 0, -50, -50)).toEqual({ col: 0, row: 0 });
    expect(cellFromPoint(screen, 80, 20, 0, 5000, 5000)).toEqual({ col: 79, row: 19 });
  });
});

describe('selection chrome geometry', () => {
  // Grid flush with a 400x300 host, 40 cols x 15 rows of 10x20, scrolled 50 rows.
  const grid = cellGrid(
    { left: 0, top: 0, width: 400, height: 300 },
    { left: 0, top: 0, width: 400, height: 300 },
    40,
    15,
    50,
  );

  it('centers the pill above a one-row selection', () => {
    const r = { startRow: 55, startCol: 10, endRow: 55, endCol: 19 };
    expect(copyPillPosition(r, grid)).toEqual({ left: 150, top: 100 - 56 });
  });

  it('centers the pill on the pane for a multi-row selection', () => {
    const r = { startRow: 55, startCol: 30, endRow: 57, endCol: 2 };
    expect(copyPillPosition(r, grid).left).toBe(200);
  });

  it('drops the pill below the selection when the top row leaves no room', () => {
    const r = { startRow: 51, startCol: 10, endRow: 51, endCol: 12 };
    expect(copyPillPosition(r, grid).top).toBe(40 + 16);
  });

  it('keeps the pill inside the host horizontally', () => {
    const r = { startRow: 55, startCol: 0, endRow: 55, endCol: 0 };
    expect(copyPillPosition(r, grid).left).toBe(44);
  });

  it('puts the handle bars flush with the selection edges', () => {
    const r = { startRow: 55, startCol: 10, endRow: 56, endCol: 19 };
    expect(handlePositions(r, grid)).toEqual({
      start: { left: 100 - 12, top: 100 - 12 },
      end: { left: 200 - 12, top: 120 },
    });
  });
});
