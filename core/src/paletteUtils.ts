/**
 * A new agent's look: which character it wears, and which copy of that
 * character it is (so two agents never look the same).
 *
 * Pure functions with no DOM/sprite dependencies — safe for use in both
 * browser (webview) and Node.js (server) environments. How a copy looks (its
 * clothes colour) is the webview's business; here a copy is only a number.
 */

import { pickDirectoryCharacter } from './directoryCharacters.js';
import type { DirectoryCharacterOrder } from './messages.js';

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
 * while some character is free, and among the free ones it prefers those no
 * Directory claims as a default (`reserved`), so a Directory's characters stay
 * available for its own launches. Only when the whole cast is in the office
 * does it repeat one.
 *
 * @param paletteCount - Total number of available palettes (e.g., 6)
 * @param worn - The looks of the agents already in the office
 * @param random - Source of randomness in [0, 1) (tests pass a fixed one)
 * @param reserved - Palettes to leave for whoever claims them (Directory defaults)
 */
export function pickRandomPalette(
  paletteCount: number,
  worn: readonly WornLook[],
  random: () => number = Math.random,
  reserved: ReadonlySet<number> = new Set(),
): number {
  const wornPalettes = new Set(worn.map((look) => look.palette));
  const free: number[] = [];
  for (let palette = 0; palette < paletteCount; palette++) {
    if (!wornPalettes.has(palette)) free.push(palette);
  }
  const unclaimed = free.filter((palette) => !reserved.has(palette));
  const pool = unclaimed.length > 0 ? unclaimed : free;
  if (pool.length > 0) return pool[Math.floor(random() * pool.length)];
  return Math.floor(random() * paletteCount);
}

export interface LookRequest {
  paletteCount: number;
  /** The looks of the agents already in the office. */
  worn: readonly WornLook[];
  /** A character picked from the roster: worn even when someone else wears it. */
  picked?: number;
  /** The launch Directory's default characters (pickDirectoryCharacter). */
  directory?: { characters?: readonly number[]; characterOrder?: DirectoryCharacterOrder };
  /** Characters a random pick leaves for their Directories (pickRandomPalette). */
  reserved?: ReadonlySet<number>;
  random?: () => number;
}

/** A roster pick as it arrives (`launchAgent.palette`, any value), when it
 *  names a character in the cast: an integer in [0, paletteCount). */
export function rosterPick(raw: unknown, paletteCount: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return raw >= 0 && raw < paletteCount ? raw : undefined;
}

/**
 * A new agent's look, first match wins: the roster pick, else one of the
 * launch Directory's defaults no one wears, else a random pick. Whichever it
 * is, an agent wearing a character already in the office is its next repeat.
 */
export function chooseLook(request: LookRequest): Look {
  const { paletteCount, worn, directory, random = Math.random } = request;
  const wornPalettes = new Set<number>();
  for (const look of worn) if (look.palette !== undefined) wornPalettes.add(look.palette);
  const palette =
    rosterPick(request.picked, paletteCount) ??
    pickDirectoryCharacter(
      directory?.characters ?? [],
      directory?.characterOrder ?? 'priority',
      paletteCount,
      wornPalettes,
      random,
    ) ??
    pickRandomPalette(paletteCount, worn, random, request.reserved);
  return { palette, repeat: repeatFor(palette, worn) };
}
