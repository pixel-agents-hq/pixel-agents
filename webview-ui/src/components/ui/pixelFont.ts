/**
 * A 3×5 pixel font for numbers anywhere in the UI ("73%", "3d 11h", "-40",
 * "3x", "v1.5", "1 / 21"): drawn as pixel art, so they stay crisp at any
 * zoom (PixelText.tsx). Words keep the UI font. Pure (no DOM), Node-tested.
 */

import { gridRuns } from './pixelGrid.js';

/** Glyph rows, '#' = lit. Every glyph is GLYPH_HEIGHT rows tall. */
export const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '%': ['#...#', '...#.', '..#..', '.#...', '#...#'],
  '-': ['...', '...', '###', '...', '...'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '.': ['.', '.', '.', '.', '#'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '#': ['.#.#.', '#####', '.#.#.', '#####', '.#.#.'],
  // Hex digits, upper case (a hex colour is drawn upper-cased: "#1E1E2E").
  A: ['###', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['###', '#..', '#..', '#..', '###'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  // The rest of the capitals the month names need ("OCT 13").
  G: ['###', '#..', '#.#', '#.#', '###'],
  J: ['..#', '..#', '..#', '#.#', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['###', '#.#', '###', '#..', '#..'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['###', '#..', '###', '..#', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  // Letters, only ever drawn with a number: units ("3d", "11h", "9m", "3x")
  // and the version's v ("v1.5").
  d: ['..#', '..#', '###', '#.#', '###'],
  h: ['#..', '#..', '###', '#.#', '#.#'],
  m: ['.....', '####.', '#.#.#', '#.#.#', '#.#.#'],
  x: ['...', '#.#', '.#.', '#.#', '...'],
  v: ['...', '#.#', '#.#', '#.#', '.#.'],
  // Between two numbers ("3d 11h"): one glyph-width blank.
  ' ': ['..', '..', '..', '..', '..'],
};

/** The month names a date is written with ("OCT 13"), in capitals. */
export const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/** A word drawn in glyphs: a number (signed, decimal) with its unit or %, a
 *  version, an upper-case hex colour, a month, the "--" of no data, or the
 *  "/" between two numbers. */
const NUMBER_WORD = new RegExp(
  `^(?:[<-]?\\d+(?:\\.\\d+)?[dhmx%]?|v\\d+(?:\\.\\d+)*|#[0-9A-F]{3,8}|${MONTHS.join('|')}|--|/)$`,
);
export const GLYPH_HEIGHT = 5;
/** Empty columns between two glyphs. */
export const GLYPH_GAP = 1;

/** A piece of a label: drawn in pixel glyphs, or left as UI-font text. */
export interface LabelPart {
  glyphs: boolean;
  text: string;
}

/** "resets in 3d 11h" → text "resets in ", glyphs "3d 11h". Only number words
 *  (and the spaces between two of them) are glyphs, so the d of "data" stays text. */
export function splitLabel(label: string): LabelPart[] {
  const words = label.split(' ');
  const parts: LabelPart[] = [];
  const push = (glyphs: boolean, text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.glyphs === glyphs) last.text += text;
    else parts.push({ glyphs, text });
  };
  words.forEach((word, i) => {
    const glyphs = NUMBER_WORD.test(word);
    if (i > 0) push(glyphs && NUMBER_WORD.test(words[i - 1]), ' ');
    if (word) push(glyphs, word);
  });
  return parts;
}

/** Lit pixels of a glyph run as rects (x, y, width; height 1), and its width. */
export function glyphRects(text: string): {
  rects: Array<[x: number, y: number, w: number]>;
  width: number;
} {
  const rects: Array<[number, number, number]> = [];
  let x0 = 0;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    rects.push(...gridRuns(glyph, x0));
    x0 += glyph[0].length + GLYPH_GAP;
  }
  return { rects, width: Math.max(0, x0 - GLYPH_GAP) };
}
