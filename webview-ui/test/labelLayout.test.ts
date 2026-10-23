/**
 * Label de-overlap (office/labelLayout.ts): seated neighbours' status labels
 * stack upward instead of covering each other — the "overlapping labels" a
 * board on a TV showed.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { LabelBox } from '../src/office/labelLayout.js';
import { resolveLabelOverlaps } from '../src/office/labelLayout.js';

const OPTS = { gap: 3, maxShift: 96, rowBand: 6 };

function box(id: number, x: number, y: number, width = 100, height = 30): LabelBox {
  return { id, x, y, width, height };
}

/** The boxes after their shifts, for asserting the geometry itself. */
function placed(boxes: LabelBox[], opts = OPTS): LabelBox[] {
  const shifts = resolveLabelOverlaps(boxes, opts);
  return boxes.map((b) => ({ ...b, y: b.y - (shifts.get(b.id) ?? 0) }));
}

function overlapping(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('resolveLabelOverlaps', () => {
  it('leaves labels that do not touch where they are', () => {
    const shifts = resolveLabelOverlaps([box(1, 0, 100), box(2, 200, 100), box(3, 0, 20)], OPTS);
    expect([...shifts.values()]).toEqual([0, 0, 0]);
  });

  it('lifts the second of two side-by-side labels clear of the first, plus the gap', () => {
    const shifts = resolveLabelOverlaps([box(1, 0, 100), box(2, 60, 100)], OPTS);
    expect(shifts.get(1)).toBe(0);
    // Its bottom lands `gap` above the other's top: 30 tall + 3 gap.
    expect(shifts.get(2)).toBe(33);
  });

  it('stacks a row of three overlapping labels with no overlap left', () => {
    const result = placed([box(1, 0, 100), box(2, 50, 100), box(3, 100, 100)]);
    for (const a of result) {
      for (const b of result) {
        if (a !== b) expect(overlapping(a, b)).toBe(false);
      }
    }
    // Only ever upward.
    for (const b of result) expect(b.y).toBeLessThanOrEqual(100);
  });

  it('moves the label that sits higher on screen, keeping the lower one on its character', () => {
    // Label 1 belongs to a character a little further back (higher up).
    const shifts = resolveLabelOverlaps([box(1, 0, 90), box(2, 40, 100)], OPTS);
    expect(shifts.get(2)).toBe(0);
    expect(shifts.get(1)).toBeGreaterThan(0);
  });

  it('within one row band, stacks by agent id whatever the input order (no frame-to-frame flips)', () => {
    // Bottoms 1px apart — same band — so the order is by id, not by y.
    const a = box(7, 0, 100);
    const b = box(3, 30, 101);
    const forward = resolveLabelOverlaps([a, b], OPTS);
    const reverse = resolveLabelOverlaps([b, a], OPTS);
    expect(forward).toEqual(reverse);
    expect(forward.get(3)).toBe(0); // lower id keeps its place
    expect(forward.get(7)).toBeGreaterThan(0);

    // A pixel of jitter either way keeps the same winner.
    const jittered = resolveLabelOverlaps([box(7, 0, 101), box(3, 30, 100)], OPTS);
    expect(jittered.get(3)).toBe(0);
    expect(jittered.get(7)).toBeGreaterThan(0);
  });

  it('caps the lift: in a crowd a label stops at maxShift instead of drifting away', () => {
    const crowd = [1, 2, 3, 4, 5, 6].map((id) => box(id, id * 10, 200));
    const shifts = resolveLabelOverlaps(crowd, OPTS);
    for (const s of shifts.values()) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(OPTS.maxShift);
    }
    // The first three fit in 96px (0, 33, 66); the rest sit at the cap.
    expect([...crowd].map((b) => shifts.get(b.id))).toEqual([0, 33, 66, 96, 96, 96]);
  });

  it('re-checks after each lift: clearing one label can land on the next one up', () => {
    // 2 is lifted above 1 (to 67). 3 only touches 1 where it starts, but just
    // above 1 is where 2 now sits — so it has to end above both.
    const result = placed([box(1, 0, 100), box(2, 50, 100), box(3, 20, 100)]);
    expect(result.map((b) => b.y)).toEqual([100, 67, 34]);
    const three = result[2];
    for (const other of result.slice(0, 2)) expect(overlapping(three, other)).toBe(false);
  });

  it('labels that merely touch side by side are not a collision', () => {
    const shifts = resolveLabelOverlaps([box(1, 0, 100), box(2, 100, 100)], OPTS);
    expect(shifts.get(2)).toBe(0);
  });
});
