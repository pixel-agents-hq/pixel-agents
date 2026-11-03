/**
 * The office radio's composer: writes one 8-bit tune as data, step by step,
 * for the four Game Boy channels (pulse lead, pulse harmony, wave bass, noise).
 * Pure and DOM-free: musicEngine.ts plays what this writes.
 *
 * Moods: Town (cheerful), Route (on the move), Lab (curious), Night (calm),
 * Orbit (floating), Rain (barely there, soft rain on the noise channel),
 * Dawn (warm morning) and Arcade (bouncy; never picked by Auto).
 *
 * A tune is an intro, a section plan like A A B A played twice (the second
 * pass varies the answer phrases and rests the melody in one section), and an
 * outro — about three minutes, then the radio picks the next one.
 */

import {
  type BassStyle,
  CADENCE,
  type DrumKit,
  FORMS,
  HALF,
  type HarmStyle,
  type Mode,
  MODE_NAME,
  type Mood,
  type MoodKey,
  MOODS,
  PROGS,
  SCALES,
} from './moods.js';
import { type Rng, rng, type Weighted } from './rng.js';
import { ROOT_MAX, ROOT_MIN } from './songCode.js';
import { tuneName } from './tuneNames.js';

/** A pulse note: MIDI pitch, length in steps, GB volume 0-15, envelope
 *  (seconds per level down `es`, floor `ef`), duty index, vibrato. */
export interface PulseEvent {
  m: number;
  len: number;
  v: number;
  es: number;
  ef: number;
  duty: number;
  vib?: boolean;
}
export interface WaveEvent {
  m: number;
  len: number;
  /** Level 0-1. */
  v: number;
  /** Share of the length that sounds. */
  gate?: number;
}
export type NoiseKind = 'h' | 's' | 'k';
export interface NoiseEvent {
  k: NoiseKind;
  v: number;
}
export interface Step {
  pu1?: PulseEvent;
  pu2?: PulseEvent;
  wav?: WaveEvent;
  noi?: NoiseEvent;
}
export interface Song {
  seed: number;
  moodKey: MoodKey;
  /** The previous tune's root this one moved from (replaying the seed needs it). */
  prevRoot: number | null;
  root: number;
  modeName: string;
  bpm: number;
  stepDur: number;
  name: string;
  steps: Step[];
}

const degToMidi = (deg: number, base: number, scale: number[]): number =>
  base + Math.floor(deg / 7) * 12 + scale[((deg % 7) + 7) % 7];
const isChordTone = (deg: number, ch: number): boolean => {
  const k = (((deg - ch) % 7) + 7) % 7;
  return k === 0 || k === 2 || k === 4;
};
function snap(deg: number, ch: number, r: Rng): number {
  if (isChordTone(deg, ch)) return deg;
  for (const k of r.chance(0.5) ? [1, -1, 2, -2] : [-1, 1, -2, 2])
    if (isChordTone(deg + k, ch)) return deg + k;
  return deg;
}
/** Keeps chord roots in a compact low range. */
const low = (c: number): number => (c >= 4 ? c - 7 : c);

interface Hit {
  start: number;
  len: number;
}
interface MelodyNote extends Hit {
  deg: number;
  final?: boolean;
}

const BUSY_CELLS: Weighted<number[]> = [
  [[2, 2], 3],
  [[3, 1], 2],
  [[1, 1, 2], 1],
  [[2, 1, 1], 1],
  [[-2, 1, 1], 1],
  [[-1, 1, 2], 0.6],
];
const CALM_CELLS: Weighted<number[]> = [
  [[4], 3],
  [[-4], 1.6],
  [[2, -2], 1.2],
  [[-2, 2], 1.4],
  [[8], 1.5],
  [[6, 2], 1],
  [[-4, 4], 0.4],
];
function genRhythm(r: Rng, steps: number, density: number): Hit[] {
  const notes: Hit[] = [];
  let pos = 0;
  while (pos < steps) {
    const left = steps - pos;
    let cell: number[];
    do {
      cell = r.weighted(r.chance(density) ? BUSY_CELLS : CALM_CELLS);
    } while (cell.reduce((s, d) => s + Math.abs(d), 0) > left);
    for (const d of cell) {
      if (d > 0) notes.push({ start: pos, len: d });
      pos += Math.abs(d);
    }
  }
  return notes;
}
const CONTOUR_STEPS: Weighted<number> = [
  [1, 4],
  [-1, 4],
  [2, 2.2],
  [-2, 2.2],
  [0, 1.2],
  [3, 0.7],
  [-3, 0.7],
  [4, 0.3],
  [-4, 0.35],
];
function genContour(r: Rng, n: number): number[] {
  const c = [0];
  let d = 0;
  for (let i = 1; i < n; i++) {
    d += r.weighted(CONTOUR_STEPS);
    if (d > 5) d -= 2;
    if (d < -5) d += 2;
    c.push(d);
  }
  return c;
}
function realize(
  r: Rng,
  rhythm: Hit[],
  contour: number[],
  start: number,
  chordAt: (step: number) => number,
  offset: number,
): MelodyNote[] {
  return rhythm.map((n, i) => {
    const st = offset + n.start;
    const ch = chordAt(st);
    let d = start + contour[i % contour.length];
    if (st % 8 === 0 || n.len >= 4) d = snap(d, ch, r);
    else if (!isChordTone(d, ch) && r.chance(0.35)) d = snap(d, ch, r);
    while (d > 9) d -= 7;
    while (d < -3) d += 7;
    return { start: st, len: n.len, deg: d };
  });
}

interface Section {
  chords: number[];
  prog: number[];
  R: Hit[];
  C: number[];
  s0: number;
  density: number;
  isB: boolean;
  harm: HarmStyle;
  bass: BassStyle;
  duty: number;
  drums1: DrumKit;
  drums2: DrumKit;
  seedA: number;
  seedB: number;
}

function makeSection(
  r: Rng,
  o: { mood: Mood; mode: Mode; bpc: number; isB: boolean; avoid: number[] | null },
): Section {
  const list = PROGS[o.mode];
  let prog: number[];
  do {
    prog = r.pick(list);
  } while (prog === o.avoid && list.length > 1);
  let chords: number[] = [];
  for (const c of prog) for (let k = 0; k < o.bpc; k++) chords.push(c);
  while (chords.length < 8) chords = chords.concat(chords);
  chords = chords.slice(0, 8);
  if (o.isB) chords[7] = HALF[o.mode];
  else [chords[6], chords[7]] = CADENCE[o.mode];
  const density = Math.min(
    0.85,
    Math.max(0.15, o.mood.density + (o.isB ? r.pick([-0.1, 0, 0.1]) : 0)),
  );
  let R: Hit[] = [];
  for (let i = 0; i < 24; i++) {
    R = genRhythm(r, 32, density);
    if (R.length >= 3 && R.length <= 11) break;
  }
  const C = genContour(r, R.length + 4);
  const s0 = snap(r.pick([2, 4, 4, 7]), chords[0], r);
  const pickKit = () => r.weighted(o.mood.kit);
  return {
    chords,
    prog,
    R,
    C,
    s0,
    density,
    isB: o.isB,
    harm: r.weighted(o.mood.harm),
    bass: r.weighted(o.mood.bass),
    duty: r.pick(o.mood.lead),
    drums1: r.chance(o.mood.drums * 0.55) ? pickKit() : 'none',
    drums2: r.chance(o.mood.drums) ? pickKit() : 'none',
    seedA: r.int(1, 2 ** 31),
    seedB: r.int(1, 2 ** 31),
  };
}

/** One 8-bar phrase: statement, answer, statement, cadence. */
function buildMelody(sec: Section, variant: number): MelodyNote[] {
  const r = rng(variant ? sec.seedB : sec.seedA);
  const chordAt = (st: number) => sec.chords[Math.min(7, Math.floor(st / 16))];
  const notes: MelodyNote[] = [];
  notes.push(...realize(r, sec.R, sec.C, sec.s0, chordAt, 0));
  let R1 = sec.R;
  let C1 = sec.C.slice();
  if (r.chance(variant ? 0.45 : 0.3)) {
    R1 = genRhythm(r, 32, sec.density);
    C1 = genContour(r, R1.length + 4);
  } else {
    const sh = r.pick([-2, -1, 1, 2]);
    for (let i = Math.floor(R1.length / 2); i < C1.length; i++) C1[i] += sh;
  }
  notes.push(...realize(r, R1, C1, sec.s0 + r.pick([-1, 0, 1]), chordAt, 32));
  notes.push(...realize(r, sec.R, sec.C, sec.s0, chordAt, 64));
  const Rc = sec.R.filter((n) => n.start < 12).map((n) => ({
    start: n.start,
    len: Math.min(n.len, 12 - n.start),
  }));
  notes.push(...realize(r, Rc, sec.C, sec.s0, chordAt, 96));
  const prev = notes.length ? notes[notes.length - 1].deg : sec.s0;
  const last = sec.chords[7];
  let cands = [-3, -1, 0, 2, 4, 5, 7, 9].filter((d) => isChordTone(d, last));
  if (!sec.isB && !r.chance(0.25)) cands = [0, 7];
  const target = cands.reduce(
    (b, d) => (Math.abs(d - prev) < Math.abs(b - prev) ? d : b),
    cands[0],
  );
  const st = r.pick([112, 112, 108]);
  notes.push({ start: st, len: 128 - st - r.pick([0, 2, 4]), deg: target, final: true });
  return notes;
}

/** One stretch of the tune, in bars: a pass through a section, or the frame around them. */
type Block =
  | { kind: 'intro' | 'outro' | 'rest'; bars: number; startBar: number }
  | {
      kind: 'sec';
      /** The section's letter in the form. */
      sec: string;
      pass: 1 | 2;
      /** The melody rests here (second pass only). */
      breather: boolean;
      bars: number;
      startBar: number;
    };

/** What the channel renderers write with: the tune's random stream, the
 *  step writer, and the lead and bass pitch for a scale degree. */
interface Tools {
  r: Rng;
  put: <K extends keyof Step>(i: number, ch: K, ev: NonNullable<Step[K]>) => void;
  lead: (deg: number) => number;
  bassM: (deg: number) => number;
}

function renderHarm(
  t: Tools,
  base: number,
  style: HarmStyle,
  chords: number[],
  melody: MelodyNote[],
  louder: boolean,
): void {
  const { r, put, lead } = t;
  const v = louder ? 1 : 0;
  if (style === 'arp8' || style === 'arp16') {
    const pat = r.pick([
      [0, 1, 2, 3],
      [0, 1, 2, 1],
      [0, 2, 1, 2],
      [3, 2, 1, 0],
      [0, 1, 2, 1, 3, 2, 1, 2],
    ]);
    const step = style === 'arp8' ? 2 : 1;
    chords.forEach((c, b) => {
      const cd = low(c);
      const tones = [cd, cd + 2, cd + 4, cd + 7];
      for (let s = 0, k = 0; s < 16; s += step, k++)
        put(base + b * 16 + s, 'pu2', {
          m: lead(tones[pat[k % pat.length]]),
          len: step,
          v: (step === 1 ? 4 : 5) + v,
          es: 0.035,
          ef: 1,
          duty: 0,
        });
    });
  } else if (style === 'echo') {
    for (const n of melody)
      if (n.start + 3 < 128)
        put(base + n.start + 3, 'pu2', {
          m: lead(n.deg),
          len: Math.max(1, n.len - 1),
          v: 5,
          es: 0.06,
          ef: 2,
          duty: 1,
        });
  } else if (style === 'thirds') {
    for (const n of melody)
      put(base + n.start, 'pu2', {
        m: lead(n.deg - 2),
        len: n.len,
        v: 6,
        es: 0.07,
        ef: 3,
        duty: 1,
      });
  } else if (style === 'off') {
    chords.forEach((c, b) => {
      const cd = low(c);
      [2, 6, 10, 14].forEach((s, k) =>
        put(base + b * 16 + s, 'pu2', {
          m: lead(cd + (k % 2 ? 4 : 2)),
          len: 1,
          v: 6 + v,
          es: 0.03,
          ef: 0,
          duty: 0,
        }),
      );
    });
  } else {
    for (let b = 0; b < chords.length; b++) {
      const c = chords[b];
      const hold = b % 2 === 0 && chords[b + 1] === c;
      put(base + b * 16, 'pu2', {
        m: lead(low(c) + 2),
        len: hold ? 32 : 16,
        v: 7 + v,
        es: 0.3,
        ef: 2,
        duty: 1,
      });
      if (hold) b++;
    }
  }
}

function renderBass(
  t: Tools,
  base: number,
  style: BassStyle,
  chords: number[],
  nextFirst: number,
): void {
  const { r, put, bassM } = t;
  for (let b = 0; b < chords.length; b++) {
    const c = chords[b];
    const cd = low(c);
    const nd = low(chords[b + 1] ?? nextFirst);
    const at = base + b * 16;
    if (style === 'roots') {
      put(at, 'wav', { m: bassM(cd), len: 6, v: 1 });
      put(at + 8, 'wav', { m: bassM(r.chance(0.4) ? cd - 3 : cd), len: 6, v: 0.8 });
    } else if (style === 'rootfifth') {
      [cd, cd + 4, cd, cd + 4].forEach((d, k) =>
        put(at + k * 4, 'wav', { m: bassM(d), len: 3, v: k % 2 ? 0.7 : 1 }),
      );
    } else if (style === 'pulse8') {
      for (let s = 0; s < 16; s += 2)
        put(at + s, 'wav', {
          m: bassM(cd) + ((s / 2) % 4 === 2 ? 12 : 0),
          len: 2,
          gate: 0.6,
          v: s % 4 === 0 ? 1 : 0.6,
        });
    } else if (style === 'walk') {
      const ap = nd < cd + 4 ? nd + 1 : nd - 1;
      [cd, cd + 2, cd + 4, ap].forEach((d, k) =>
        put(at + k * 4, 'wav', { m: bassM(d), len: 3, v: k ? 0.75 : 1 }),
      );
    } else {
      const hold = b % 2 === 0 && chords[b + 1] === c;
      put(at, 'wav', { m: bassM(cd), len: hold ? 30 : 14, v: 1 });
      if (hold) b++;
    }
  }
}

function renderDrums(t: Tools, base: number, kit: DrumKit, bars: number, fill: boolean): void {
  const { r, put } = t;
  if (kit === 'none') return;
  for (let b = 0; b < bars; b++) {
    const at = base + b * 16;
    if (kit === 'hats')
      for (let s = 0; s < 16; s += 2) put(at + s, 'noi', { k: 'h', v: s % 4 === 0 ? 0.55 : 0.3 });
    if (kit === 'brush') {
      for (const [s, v] of [
        [0, 0.5],
        [6, 0.3],
        [8, 0.5],
        [14, 0.3],
      ])
        put(at + s, 'noi', { k: 'h', v });
      if (b % 2) put(at + 12, 'noi', { k: 's', v: 0.3 });
    }
    if (kit === 'groove') {
      for (const s of [2, 6, 10, 14]) put(at + s, 'noi', { k: 'h', v: 0.35 });
      put(at, 'noi', { k: 'k', v: 0.7 });
      put(at + 8, 'noi', { k: 'k', v: 0.55 });
      put(at + 4, 'noi', { k: 's', v: 0.4 });
      put(at + 12, 'noi', { k: 's', v: 0.4 });
    }
    if (kit === 'rain')
      // Soft ticks scattered at random: rain on the window, never a beat.
      for (let s = 0; s < 16; s++)
        if (r.chance(0.3)) put(at + s, 'noi', { k: 'h', v: 0.06 + r() * 0.12 });
    if (fill && b === bars - 1 && kit !== 'hats' && kit !== 'rain') {
      put(at + 13, 'noi', { k: 's', v: 0.25 });
      put(at + 14, 'noi', { k: 's', v: 0.32 });
      put(at + 15, 'noi', { k: 's', v: 0.4 });
    }
  }
}

/** Writes one tune. The same seed, mood and root give the same tune: the
 *  root comes from the previous tune's (`prevRoot`), or is pinned by `root`
 *  (a shared song code). */
export function makeSong(
  seed: number,
  moodKey: MoodKey,
  prevRoot: number | null,
  pinnedRoot?: number,
): Song {
  const r = rng(seed);
  const mood = MOODS[moodKey];
  const mode = r.weighted(mood.modes);
  const scale = SCALES[mode];
  // Both branches take exactly one draw, so a pinned root (below) leaves the
  // rest of the stream, and so the tune, as the code's original wrote it.
  let root =
    prevRoot == null ? r.int(ROOT_MIN, ROOT_MAX) : prevRoot + r.pick([-5, -3, -2, 0, 2, 3, 5]);
  const span = ROOT_MAX - ROOT_MIN + 1;
  root = ROOT_MIN + ((((root - ROOT_MIN) % span) + span) % span); // D3..A#3
  if (pinnedRoot !== undefined) root = pinnedRoot; // after the draw, so the rest is the same
  const bpm = r.int(mood.bpm[0], mood.bpm[1]);
  const bpc = r.weighted(mood.bpc);
  const form = r.pick(FORMS);
  const secs: Record<string, Section> = {};
  let prev: number[] | null = null;
  for (const L of [...new Set(form)]) {
    secs[L] = makeSection(r, { mood, mode, bpc, isB: L !== 'A', avoid: prev });
    prev = secs[L].prog;
  }

  const breatherAt = 1 + r.int(0, form.length - 2);
  const blocks: Block[] = [{ kind: 'intro', bars: 2, startBar: 0 }];
  form.forEach((L) =>
    blocks.push({ kind: 'sec', sec: L, pass: 1, breather: false, bars: 8, startBar: 0 }),
  );
  form.forEach((L, i) =>
    blocks.push({ kind: 'sec', sec: L, pass: 2, bars: 8, startBar: 0, breather: i === breatherAt }),
  );
  blocks.push({ kind: 'outro', bars: 2, startBar: 0 }, { kind: 'rest', bars: 1, startBar: 0 });
  let bar = 0;
  for (const b of blocks) {
    b.startBar = bar;
    bar += b.bars;
  }

  const S: Step[] = Array.from({ length: bar * 16 }, () => ({}));
  const put: Tools['put'] = (i, ch, ev) => {
    if (i >= 0 && i < S.length) S[i][ch] = ev;
  };
  const lead = (d: number) => degToMidi(d, root + 12, scale);
  const bassM = (d: number) => degToMidi(d, root - 12, scale);
  const t: Tools = { r, put, lead, bassM };

  const first = secs[form[0]];
  blocks.forEach((blk, bi) => {
    const base = blk.startBar * 16;
    if (blk.kind === 'intro') {
      const style = first.harm === 'echo' || first.harm === 'thirds' ? 'arp8' : first.harm;
      renderHarm(t, base, style, first.chords.slice(0, 2), [], false);
      renderBass(t, base, first.bass, first.chords.slice(0, 2), first.chords[2]);
    } else if (blk.kind === 'sec') {
      const sec = secs[blk.sec];
      const { pass } = blk;
      const melody = blk.breather ? [] : buildMelody(sec, pass - 1);
      const duty = pass === 2 && r.chance(0.35) ? r.pick([0, 1, 2]) : sec.duty;
      for (const n of melody)
        put(base + n.start, 'pu1', {
          m: lead(n.deg),
          len: n.len,
          v: n.final ? 10 : 11,
          es: n.final ? 0.16 : n.len >= 6 ? 0.12 : 0.05,
          ef: n.len >= 6 ? 6 : 4,
          duty,
          vib: n.len >= 5,
        });
      let style = pass === 2 && r.chance(0.35) ? r.weighted(mood.harm) : sec.harm;
      if (blk.breather) style = r.pick<HarmStyle>(['pad', 'arp8']);
      if (!melody.length && (style === 'echo' || style === 'thirds')) style = 'arp8';
      renderHarm(t, base, style, sec.chords, melody, blk.breather);
      const nextBlk = blocks[bi + 1];
      const nextFirst = nextBlk?.kind === 'sec' ? secs[nextBlk.sec].chords[0] : 0;
      renderBass(
        t,
        base,
        pass === 2 && r.chance(0.25) ? r.weighted(mood.bass) : sec.bass,
        sec.chords,
        nextFirst,
      );
      renderDrums(
        t,
        base,
        pass === 1 ? sec.drums1 : sec.drums2,
        8,
        !nextBlk || nextBlk.kind === 'sec',
      );
    } else if (blk.kind === 'outro') {
      put(base, 'wav', { m: bassM(0), len: 28, v: 1 });
      put(base, 'pu2', { m: lead(2), len: 28, v: 6, es: 0.3, ef: 0, duty: 1 });
      put(base, 'pu1', {
        m: lead(first.s0 > 3 ? 7 : 0),
        len: 28,
        v: 9,
        es: 0.22,
        ef: 0,
        duty: first.duty,
        vib: true,
      });
    }
  });

  // Each channel is monophonic: a new note cuts the previous one.
  for (const ch of ['pu1', 'pu2', 'wav'] as const) {
    let last = -1;
    for (let i = 0; i < S.length; i++) {
      const ev = S[i][ch];
      if (!ev) continue;
      const prevEv = last >= 0 ? S[last][ch] : undefined;
      if (prevEv) prevEv.len = Math.min(prevEv.len, i - last);
      last = i;
    }
  }

  return {
    seed,
    moodKey,
    prevRoot,
    root,
    modeName: MODE_NAME[mode],
    bpm,
    stepDur: 60 / bpm / 4,
    name: tuneName(r, moodKey),
    steps: S,
  };
}
