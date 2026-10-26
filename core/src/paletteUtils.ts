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
 * A character picked at random for a new agent, by design not the least-used
 * one: who walks in is a surprise. It never repeats one already in the office
 * while some character is free. Only when the whole cast is in the office
 * does it repeat one.
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
  const wornPalettes = new Set(worn.map((look) => look.palette));
  const free: number[] = [];
  for (let palette = 0; palette < paletteCount; palette++) {
    if (!wornPalettes.has(palette)) free.push(palette);
  }
  if (free.length > 0) return free[Math.floor(random() * free.length)];
  return Math.floor(random() * paletteCount);
}

export interface LookRequest {
  paletteCount: number;
  /** The looks of the agents already in the office. */
  worn: readonly WornLook[];
  random?: () => number;
}

/**
 * A new agent's look: a random character no one wears (pickRandomPalette).
 * An agent wearing a character already in the office is its next repeat.
 */
export function chooseLook(request: LookRequest): Look {
  const { paletteCount, worn, random = Math.random } = request;
  const palette = pickRandomPalette(paletteCount, worn, random);
  return { palette, repeat: repeatFor(palette, worn) };
}
