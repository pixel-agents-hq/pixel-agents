/** Pure rules shared by the agent card bars — highlight tier and the mobile
 *  bar's drag-to-reorder order (DOM-free, so they run on the Node runner). */

/** Card highlight tiers: 'focused' = the agent's character is selected in the
 *  office (active background, no border); 'active' = its terminal pane is the
 *  one showing (background + accent border). */
export type CardVariant = 'default' | 'focused' | 'active';

/** One rule for both card bars: the showing terminal pane wins, then the
 *  character selected in the office. Pass activeId null where no pane shows
 *  (VS Code, or the mobile office page). */
export function cardVariant(
  agentId: number,
  { activeId, focusedId }: { activeId: number | null; focusedId: number | null },
): CardVariant {
  if (agentId === activeId) return 'active';
  if (agentId === focusedId) return 'focused';
  return 'default';
}

/** Saved order first (dropping closed agents), then any new agents appended
 *  in creation order — so a reorder survives launches and closes. */
export function mergeOrder(saved: readonly number[], live: readonly number[]): number[] {
  const liveSet = new Set(live);
  const ordered = saved.filter((id) => liveSet.has(id));
  const seen = new Set(ordered);
  for (const id of live) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * The order with `dragId` moved to where the finger is: before the first
 * other card whose horizontal midpoint lies right of `x`, else last.
 * `midpointOf` returns a card's midpoint in the same coordinate space as `x`
 * (null for a card that isn't laid out, which is skipped).
 */
export function reorderByPointer(
  ids: readonly number[],
  dragId: number,
  midpointOf: (id: number) => number | null,
  x: number,
): number[] {
  const others = ids.filter((id) => id !== dragId);
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const mid = midpointOf(others[i]);
    if (mid !== null && x < mid) {
      insertAt = i;
      break;
    }
  }
  return [...others.slice(0, insertAt), dragId, ...others.slice(insertAt)];
}
