/** Song codes: a tune as mood, key and seed, short enough to share. */

import type { Song } from './composer.js';
import { MOOD_KEYS, type MoodKey } from './moods.js';

/** The lowest and highest tune roots (MIDI): D3..A#3. */
export const ROOT_MIN = 50;
export const ROOT_MAX = 58;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** "D mixolydian" */
export const keyLabel = (song: Song): string => `${NOTE_NAMES[song.root % 12]} ${song.modeName}`;

/** A tune as a short shareable code: mood, key and seed, "TOWN-5-8F3A21C0". */
export const songCode = (song: Song): string =>
  `${song.moodKey.toUpperCase()}-${song.root - ROOT_MIN}-${song.seed.toString(16).toUpperCase().padStart(8, '0')}`;

/** Reads a song code back; null when it isn't one. */
export function parseSongCode(
  code: string,
): { moodKey: MoodKey; root: number; seed: number } | null {
  // The UI font draws 0 like an o: read a typed o as the 0 it meant.
  const m = /^\s*([a-z]+)-([\do])-([0-9a-fo]{1,8})\s*$/i.exec(code);
  if (!m) return null;
  const moodKey = m[1].toLowerCase() as MoodKey;
  const root = ROOT_MIN + Number(m[2].replace(/o/i, '0'));
  if (!MOOD_KEYS.includes(moodKey) || root > ROOT_MAX) return null;
  return { moodKey, root, seed: parseInt(m[3].replace(/o/gi, '0'), 16) >>> 0 };
}
