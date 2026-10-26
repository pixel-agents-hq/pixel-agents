/** Pure rules shared by the agent card bars — which agents get a card and in
 *  what order, highlight tier, the ×, and drag-to-reorder (DOM-free, so they
 *  run on the Node runner). */

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

/** How a card shows its ×: always, on hover, or not at all. */
export type CloseMode = 'shown' | 'hover' | 'hidden';

/** The × rule: on hover (desktop), or with `onlyWhenActive` (phone: a stray
 *  tap must not close an agent) only on the active card. */
export function closeMode(variant: CardVariant, onlyWhenActive: boolean): CloseMode {
  if (!onlyWhenActive) return 'hover';
  return variant === 'active' ? 'shown' : 'hidden';
}

/** The cards, in order: main agents only (a Teammate is shown by its
 *  character beside its Lead, never as a card of its own), in the saved
 *  order with new ones appended (mergeOrder). */
export function cardOrderOf(
  saved: readonly number[],
  agents: readonly number[],
  teammateIds: ReadonlySet<number>,
): number[] {
  return mergeOrder(
    saved,
    agents.filter((id) => !teammateIds.has(id)),
  );
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
 * The order with `dragId` moved to where the pointer is: before the first
 * other card whose midpoint along the bar's axis lies past `x` (the pointer's
 * coordinate on that axis), else last.
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
