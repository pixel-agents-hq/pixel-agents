/**
 * A new agent's look: which character it wears, and which copy of that
 * character it is (so two agents never look the same).
 *
 * Pure functions with no DOM/sprite dependencies — safe for use in both
 * browser (webview) and Node.js (server) environments. How a copy looks (its
 * clothes colour) is the webview's business; here a copy is only a number.
 */

/**
 * An agent's look. `repeat` counts the copies of one character in the
 * office: 0 is the character as drawn, 1 its first repeat, 2 the next…
 */
export interface Look {
  palette: number;
  repeat: number;
}

/** An agent's look as far as picking goes (either part may still be unset). */
export type WornLook = Partial<Look>;

/** The repeat a new agent wearing `palette` gets: the lowest one no agent in
 *  `worn` wearing that character holds (0 when no one wears it). */
export function repeatFor(palette: number, worn: Iterable<WornLook>): number {
  const taken = new Set<number>();
  for (const look of worn) {
    if (look.palette === palette) taken.add(look.repeat ?? 0);
  }
  let repeat = 0;
  while (taken.has(repeat)) repeat++;
  return repeat;
}

/**
 * A character picked at random for a new agent among those with the fewest
 * copies in the office: who walks in is a surprise, but the copies stay even.
 * It never repeats one already in the office while some character is free,
 * and once the whole cast is in, no character gets a third copy until every
 * one has a second (and so on).
 *
 * @param paletteCount - Total number of available palettes (e.g., 6)
 * @param worn - The looks of the agents already in the office
 * @param random - Source of randomness in [0, 1) (tests pass a fixed one)
 */
export function pickRandomPalette(
  paletteCount: number,
  worn: readonly WornLook[],
  random: () => number = Math.random,
): number {
  const copies = new Array<number>(paletteCount).fill(0);
  for (const look of worn) {
    if (look.palette !== undefined && look.palette < paletteCount) copies[look.palette]++;
  }
  const fewest = Math.min(...copies);
  const candidates: number[] = [];
  for (let palette = 0; palette < paletteCount; palette++) {
    if (copies[palette] === fewest) candidates.push(palette);
  }
  return candidates[Math.floor(random() * candidates.length)];
}

export interface LookRequest {
  paletteCount: number;
  /** The looks of the agents already in the office. */
  worn: readonly WornLook[];
  random?: () => number;
}

/**
 * A new agent's look: a random character among the least worn (pickRandomPalette).
 * An agent wearing a character already in the office is its next repeat.
 */
export function chooseLook(request: LookRequest): Look {
  const { paletteCount, worn, random = Math.random } = request;
  const palette = pickRandomPalette(paletteCount, worn, random);
  return { palette, repeat: repeatFor(palette, worn) };
}
