/**
 * A Directory's default characters: who agents launched into it wear when no
 * character was picked from the roster.
 *
 * Pure (no DOM, no Node): the server validates and applies them, the webview
 * shows them. Characters are palette indices — profile N is palette N, then any
 * external char_N.png — like every other character reference on the wire.
 */

import type { DirectoryCharacterOrder } from './messages.js';

/** The most defaults a Directory keeps (more could never all be shown or worn). */
export const MAX_DIRECTORY_CHARACTERS = 64;

/** A loose value as a Directory's defaults: non-negative integers, deduped (first
 *  occurrence keeps its priority), at most MAX_DIRECTORY_CHARACTERS. */
export function parseDirectoryCharacters(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || out.includes(v)) continue;
    out.push(v);
    if (out.length === MAX_DIRECTORY_CHARACTERS) break;
  }
  return out;
}

/** A loose value as a pick order; anything but 'random' is the default, 'priority'. */
export function parseCharacterOrder(raw: unknown): DirectoryCharacterOrder {
  return raw === 'random' ? 'random' : 'priority';
}

/**
 * The character a launch into a Directory wears, or undefined to leave it to
 * the server's own random pick (pickRandomPalette: a character no one in the
 * office wears, preferably no Directory's default).
 *
 * - `priority`: the first default no agent in the office wears.
 * - `random`: a random default no agent wears.
 *
 * Either way a default already in the office is never repeated: all worn →
 * undefined. Defaults past `paletteCount` (a deleted character) are skipped.
 */
export function pickDirectoryCharacter(
  characters: readonly number[],
  order: DirectoryCharacterOrder,
  paletteCount: number,
  worn: ReadonlySet<number>,
  random: () => number = Math.random,
): number | undefined {
  const free = characters.filter((c) => c < paletteCount && !worn.has(c));
  if (free.length === 0) return undefined;
  return order === 'priority' ? free[0] : free[Math.floor(random() * free.length)];
}
