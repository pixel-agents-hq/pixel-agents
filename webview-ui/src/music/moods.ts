/**
 * The radio's moods and the music theory they draw on: scales, chord
 * progressions, cadences and section forms, plus Auto's choice of the next
 * mood. Tables only (and chooseMood); composer.ts writes the tunes.
 */

import { newSeed, rng, type Weighted } from './rng.js';

/** The moods, in the order the player lists them. */
export const MOOD_KEYS = [
  'town',
  'route',
  'lab',
  'night',
  'orbit',
  'rain',
  'dawn',
  'arcade',
] as const;
export type MoodKey = (typeof MOOD_KEYS)[number];
export type MoodSetting = MoodKey | 'auto';
export type Mode = 'ionian' | 'dorian' | 'mixolydian' | 'aeolian' | 'lydian';
export type HarmStyle = 'arp8' | 'arp16' | 'echo' | 'thirds' | 'off' | 'pad';
export type BassStyle = 'roots' | 'rootfifth' | 'pulse8' | 'walk' | 'long';
export type DrumKit = 'none' | 'hats' | 'brush' | 'groove' | 'rain';

export const SCALES: Record<Mode, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};
export const MODE_NAME: Record<Mode, string> = {
  ionian: 'major',
  dorian: 'dorian',
  mixolydian: 'mixolydian',
  aeolian: 'minor',
  lydian: 'lydian',
};
/** Chord progressions as scale degrees (0 = tonic). */
export const PROGS: Record<Mode, number[][]> = {
  ionian: [
    [0, 5, 3, 4],
    [0, 3, 0, 4],
    [5, 3, 0, 4],
    [0, 2, 3, 4],
    [0, 3, 4, 0],
    [3, 4, 2, 5],
    [0, 4, 5, 3],
    [1, 4, 0, 5],
    [0, 5, 1, 4],
  ],
  mixolydian: [
    [0, 6, 3, 0],
    [0, 3, 6, 0],
    [0, 4, 6, 3],
    [0, 6, 0, 3],
  ],
  lydian: [
    [0, 1, 0, 1],
    [0, 1, 4, 1],
    [0, 1, 5, 4],
    [0, 2, 1, 4],
  ],
  dorian: [
    [0, 3, 0, 3],
    [0, 6, 3, 0],
    [0, 2, 3, 6],
    [0, 4, 6, 3],
    [0, 3, 6, 2],
  ],
  aeolian: [
    [0, 5, 6, 0],
    [0, 3, 4, 0],
    [0, 5, 2, 6],
    [0, 6, 5, 4],
    [0, 3, 5, 6],
  ],
};
export const CADENCE: Record<Mode, [number, number]> = {
  ionian: [4, 0],
  mixolydian: [6, 0],
  lydian: [1, 0],
  dorian: [6, 0],
  aeolian: [6, 0],
};
export const HALF: Record<Mode, number> = {
  ionian: 4,
  mixolydian: 4,
  lydian: 1,
  dorian: 3,
  aeolian: 4,
};

export interface Mood {
  label: string;
  modes: Weighted<Mode>;
  bpm: [number, number];
  density: number;
  /** Bars per chord. */
  bpc: Weighted<number>;
  drums: number;
  kit: Weighted<DrumKit>;
  harm: Weighted<HarmStyle>;
  bass: Weighted<BassStyle>;
  /** Lead duty indices to pick from. */
  lead: number[];
}

export const MOODS: Record<MoodKey, Mood> = {
  town: {
    label: 'Town',
    modes: [
      ['ionian', 3],
      ['mixolydian', 1],
      ['lydian', 0.5],
    ],
    bpm: [88, 104],
    density: 0.5,
    bpc: [
      [1, 3],
      [2, 1],
    ],
    drums: 0.35,
    kit: [
      ['hats', 2],
      ['brush', 2],
    ],
    harm: [
      ['arp8', 3],
      ['thirds', 2],
      ['echo', 2],
      ['off', 2],
      ['pad', 1],
    ],
    bass: [
      ['roots', 2],
      ['rootfifth', 3],
      ['walk', 1.5],
      ['pulse8', 1],
    ],
    lead: [1, 2, 2],
  },
  route: {
    label: 'Route',
    modes: [
      ['ionian', 3],
      ['mixolydian', 2],
    ],
    bpm: [108, 122],
    density: 0.6,
    bpc: [[1, 1]],
    drums: 0.85,
    kit: [
      ['groove', 3],
      ['hats', 1],
    ],
    harm: [
      ['arp8', 2],
      ['arp16', 1],
      ['echo', 2],
      ['off', 2],
      ['thirds', 1.5],
    ],
    bass: [
      ['pulse8', 3],
      ['rootfifth', 2],
      ['walk', 1],
    ],
    lead: [2, 1, 2],
  },
  lab: {
    label: 'Lab',
    modes: [
      ['lydian', 2],
      ['ionian', 1],
      ['dorian', 1],
    ],
    bpm: [92, 108],
    density: 0.45,
    bpc: [
      [1, 2],
      [2, 1],
    ],
    drums: 0.5,
    kit: [
      ['hats', 2],
      ['brush', 1],
    ],
    harm: [
      ['arp16', 1],
      ['arp8', 3],
      ['echo', 2],
      ['off', 1],
    ],
    bass: [
      ['rootfifth', 2],
      ['pulse8', 1.5],
      ['roots', 1.5],
    ],
    lead: [0, 1],
  },
  night: {
    label: 'Night',
    modes: [
      ['dorian', 2],
      ['aeolian', 2],
      ['lydian', 0.7],
    ],
    bpm: [68, 82],
    density: 0.3,
    bpc: [
      [2, 3],
      [1, 1],
    ],
    drums: 0.15,
    kit: [['brush', 1]],
    harm: [
      ['pad', 3],
      ['arp8', 2],
      ['echo', 2],
    ],
    bass: [
      ['long', 3],
      ['roots', 2],
    ],
    lead: [0, 1, 1],
  },
  orbit: {
    label: 'Orbit',
    modes: [
      ['lydian', 3],
      ['ionian', 1],
      ['mixolydian', 1],
    ],
    bpm: [64, 76],
    density: 0.28,
    bpc: [
      [2, 3],
      [1, 1],
    ],
    drums: 0.1,
    kit: [['hats', 1]],
    harm: [
      ['arp8', 3],
      ['pad', 2],
      ['echo', 2],
    ],
    bass: [
      ['long', 3],
      ['roots', 1],
    ],
    lead: [0, 1],
  },
  rain: {
    label: 'Rain',
    modes: [
      ['aeolian', 2],
      ['dorian', 2],
      ['ionian', 0.5],
    ],
    bpm: [70, 82],
    density: 0.24,
    bpc: [
      [2, 2],
      [1, 1],
    ],
    drums: 1,
    kit: [['rain', 1]],
    harm: [
      ['pad', 3],
      ['echo', 1],
      ['arp8', 1],
    ],
    bass: [
      ['long', 3],
      ['roots', 1],
    ],
    lead: [1, 1, 0],
  },
  dawn: {
    label: 'Dawn',
    modes: [
      ['ionian', 3],
      ['lydian', 1.5],
      ['mixolydian', 0.5],
    ],
    bpm: [78, 92],
    density: 0.38,
    bpc: [
      [1, 2],
      [2, 2],
    ],
    drums: 0.3,
    kit: [
      ['brush', 2],
      ['hats', 1],
    ],
    harm: [
      ['pad', 2],
      ['arp8', 2],
      ['thirds', 2],
      ['echo', 1],
    ],
    bass: [
      ['long', 2],
      ['roots', 2],
      ['rootfifth', 1],
    ],
    lead: [1, 2],
  },
  arcade: {
    label: 'Arcade',
    modes: [
      ['ionian', 3],
      ['mixolydian', 2],
      ['dorian', 1],
    ],
    bpm: [116, 128],
    density: 0.68,
    bpc: [[1, 1]],
    drums: 0.95,
    kit: [
      ['groove', 3],
      ['hats', 1],
    ],
    harm: [
      ['arp16', 3],
      ['arp8', 2],
      ['off', 2],
      ['thirds', 1],
    ],
    bass: [
      ['pulse8', 3],
      ['walk', 2],
      ['rootfifth', 1],
    ],
    lead: [2, 1, 2],
  },
};

/** Auto mode's base pull toward each mood. Arcade is never picked on its own. */
const AUTO_WEIGHT: Record<MoodKey, number> = {
  town: 2,
  route: 2,
  lab: 1.5,
  night: 1,
  orbit: 1.2,
  rain: 1,
  dawn: 1,
  arcade: 0,
};
const CALM: ReadonlySet<MoodKey> = new Set(['night', 'orbit', 'rain']);
export const FORMS = [
  ['A', 'A', 'B', 'A'],
  ['A', 'B', 'A', 'B'],
  ['A', 'B', 'A', 'C'],
  ['A', 'B', 'B', 'A'],
  ['A', 'A', 'B', 'B'],
];

/** The next tune's mood: the setting, or on Auto a drift from the last one
 *  (rarely the same again, calm leading to calm) that leans toward Night late
 *  and Dawn in the morning. */
export function chooseMood(setting: MoodSetting, prev: MoodKey | null, hour: number): MoodKey {
  if (setting !== 'auto') return setting;
  const w = { ...AUTO_WEIGHT };
  if (prev) {
    w[prev] *= 0.6;
    if (CALM.has(prev)) {
      for (const k of CALM) w[k] *= 1.5;
      w.route *= 0.4;
    }
  }
  w.night *= hour >= 20 || hour < 7 ? 4 : 0.4;
  w.dawn *= hour >= 6 && hour < 10 ? 4 : 0.25;
  return rng(newSeed()).weighted(Object.entries(w) as Weighted<MoodKey>);
}
