/**
 * The launch roster's order: the characters launched most recently first, the rest
 * in cast order. The recent list is the server's (server/src/recentCharacters.ts),
 * so every office orders the roster the same way. Characters are kept by cast index.
 */

/**
 * The indices of a `count`-character cast in roster order: the used ones by recency
 * (indices past the end dropped), then the never-used ones in cast order.
 */
export function rosterOrder(count: number, recent: readonly number[]): number[] {
  const used = [...new Set(recent)].filter((i) => i < count);
  const seen = new Set(used);
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
  return [...used, ...rest];
}
