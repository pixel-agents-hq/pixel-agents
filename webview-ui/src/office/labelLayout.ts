/**
 * Status-label de-overlap for the ToolOverlay, as pure geometry.
 *
 * Every label sits above its own character, so agents seated side by side (or
 * a helper next to its parent) put their labels on top of each other. This
 * resolves that greedily, bottom-up: the lowest label keeps its place, and a
 * label colliding with one already placed lifts until it clears it, plus a
 * gap. Labels only ever move UP (toward the open space above the office row
 * they belong to) and never by more than `maxShift`, so a label can't drift
 * off its character in a crowd — at the cap it stops and overlaps instead.
 *
 * Frame-to-frame stability matters as much as the geometry: the overlay
 * recomputes every frame, and an order that flips between two near-equal
 * labels makes them swap places 60 times a second. Bottom edges are therefore
 * compared in bands (`rowBand` px), and labels in one band go in agent-id
 * order — two seated neighbours always stack the same way round.
 *
 * Screen space, CSS px, y growing downward; (x, y) is the box's top-left.
 */

export interface LabelBox {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelLayoutOptions {
  /** Vertical clearance kept between stacked labels. */
  gap: number;
  /** The most a label is ever lifted above where it wants to be. */
  maxShift: number;
  /** Bottom edges in the same band of this many px count as one row. */
  rowBand: number;
}

/** Whether `a` (moved to top `y`) and `b` overlap, counting the gap as part of
 *  each box vertically. Boxes that merely touch side by side don't. */
function collides(a: LabelBox, y: number, b: LabelBox, gap: number): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    y < b.y + b.height + gap &&
    b.y < y + a.height + gap
  );
}

/**
 * The upward shift (px, ≥ 0) for each label so that none overlap, keyed by
 * label id; labels that needn't move map to 0. Deterministic for a given set
 * of boxes, whatever order they arrive in.
 */
export function resolveLabelOverlaps(
  boxes: readonly LabelBox[],
  { gap, maxShift, rowBand }: LabelLayoutOptions,
): Map<number, number> {
  const band = (b: LabelBox) => Math.floor((b.y + b.height) / rowBand);
  // Lowest row first; within a row, by agent id.
  const order = [...boxes].sort((a, b) => band(b) - band(a) || a.id - b.id);

  const shifts = new Map<number, number>();
  const placed: LabelBox[] = [];
  for (const box of order) {
    const highest = box.y - maxShift;
    let y = box.y;
    // Every pass clears all the labels it collides with (rising above the
    // topmost of them) and a cleared label can't be hit again — the label only
    // rises — so this ends after at most placed.length passes.
    for (;;) {
      const hits = placed.filter((other) => collides(box, y, other, gap));
      if (hits.length === 0) break;
      const lifted = Math.min(...hits.map((other) => other.y)) - gap - box.height;
      if (lifted < highest) {
        y = highest;
        break;
      }
      y = lifted;
    }
    shifts.set(box.id, box.y - y);
    placed.push({ ...box, y });
  }
  return shifts;
}
