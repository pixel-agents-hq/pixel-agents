/**
 * The Lounge radio's lo-fi loop as data (pure, DOM-free, unit-tested): a soft
 * four-chord progression, a round bass, a lazy kick/snare/hat, and a short
 * pentatonic noodle on top, one 16th-note step at a time. lofiRadio.ts plays it.
 */

/** Midi note → Hz. */
export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Fmaj7 · Em7 · Dm7 · Cmaj7, voiced low and close (one bar each). */
const CHORDS: ReadonlyArray<{ root: number; notes: readonly number[] }> = [
  { root: 41, notes: [57, 60, 64, 65] }, // Fmaj7: A C E F
  { root: 40, notes: [55, 59, 62, 64] }, // Em7:   G B D E
  { root: 38, notes: [53, 57, 60, 62] }, // Dm7:   F A C D
  { root: 36, notes: [52, 55, 59, 60] }, // Cmaj7: E G B C
];

/** The melody, one bar per line, a midi note or `.` (rest) per 16th. */
const MELODY_TEXT = [
  '72 . . 69 . . 67 . 69 . . . 64 . . .',
  '71 . . 67 . 64 . . 62 . . . . . . .',
  '69 . . 72 . . 74 . 72 . 69 . . . . .',
  '67 . 64 . . 62 . . 64 . . . . . . .',
];
const MELODY: ReadonlyArray<number | null> = MELODY_TEXT.join(' ')
  .split(' ')
  .map((s) => (s === '.' ? null : Number(s)));

export const STEPS_PER_BAR = 16;
export const LOOP_STEPS = STEPS_PER_BAR * CHORDS.length;

export interface LofiStep {
  /** A new chord starts (pad notes, midi). */
  chord: readonly number[] | null;
  /** Bass note (midi). */
  bass: number | null;
  kick: boolean;
  snare: boolean;
  hat: boolean;
  /** Melody note (midi). */
  lead: number | null;
}

/** What plays on a 16th-note step of the 4-bar loop. */
export function lofiStep(step: number): LofiStep {
  const s = ((step % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  const bar = Math.floor(s / STEPS_PER_BAR);
  const beat = s % STEPS_PER_BAR;
  const chord = CHORDS[bar];
  return {
    chord: beat === 0 ? chord.notes : null,
    bass: beat === 0 || beat === 10 ? chord.root : beat === 7 ? chord.root + 7 : null,
    kick: beat === 0 || beat === 7 || beat === 10,
    snare: beat === 4 || beat === 12,
    hat: beat % 2 === 0,
    lead: MELODY[s] ?? null,
  };
}
