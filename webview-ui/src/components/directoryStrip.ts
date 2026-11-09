/**
 * Which of a Directory's default characters its launch-drawer row shows: all of
 * them up to DIRECTORY_STRIP_MAX + 1, else DIRECTORY_STRIP_MAX mug shots plus a
 * silhouette for the rest. Pure, so the Node runner tests it.
 */

import type { DirectoryCharacterOrder } from '../../../core/src/messages.js';
import { DIRECTORY_STRIP_MAX } from '../constants.js';

export interface DirectoryStrip {
  /** Palette indices to draw, first first. Shorter than `all` = the rest
   *  hide behind the silhouette. */
  shown: number[];
  /** Every default, in the same order: `shown` then the rest (the silhouette
   *  pressed shows them all). */
  all: number[];
}

/**
 * Priority order shows the first defaults; random order a random few (the
 * launch could pick any of them). Defaults past `paletteCount` (a deleted
 * character) are left out.
 */
export function directoryStrip(
  characters: readonly number[] | undefined,
  order: DirectoryCharacterOrder | undefined,
  paletteCount: number,
  random: () => number = Math.random,
): DirectoryStrip {
  const valid = (characters ?? []).filter((c) => c < paletteCount);
  const pool = order === 'random' ? shuffle(valid, random) : valid;
  // The "..." takes a mug shot's room, so it only stands in for two or more:
  // one past the limit simply shows.
  const fits = pool.length <= DIRECTORY_STRIP_MAX + 1;
  return { shown: fits ? pool : pool.slice(0, DIRECTORY_STRIP_MAX), all: pool };
}

function shuffle(items: readonly number[], random: () => number): number[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
