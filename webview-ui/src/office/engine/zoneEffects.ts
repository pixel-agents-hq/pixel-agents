/**
 * Living-office effects drawn by the renderer rather than shipped as sprites
 * (docs/office/DESIGN.md, Art): a character's smoke break at a Smoke spot —
 * the lighter, the drags (inhale glow, exhale cloud), wisps off the tip, ash
 * flicks and the stub-out — plus who faces whom when several smoke, and how
 * full the ashtray is. Pure: time in, geometry out, in sprite px relative to
 * the character's feet anchor (ch.x, ch.y), so the renderer only scales and
 * fills, and the timeline is testable without a canvas.
 */

import {
  ASHTRAY_BUTT_SLOTS,
  ASHTRAY_BUTT_WAIT_SEC,
  CIGARETTE_FILTER_COLOR,
  CIGARETTE_LENGTH_PX,
  CIGARETTE_PAPER_COLOR,
  SMOKE_ASH_DRIFT_PX,
  SMOKE_ASH_FALL_PX,
  SMOKE_ASH_FALL_SEC,
  SMOKE_ASH_FLICK_AFTER_SEC,
  SMOKE_ASH_FLICK_CHANCE,
  SMOKE_DRAG_JITTER_SEC,
  SMOKE_DRAG_PERIOD_SEC,
  SMOKE_EXHALE_DELAY_SEC,
  SMOKE_EXHALE_LIFETIME_SEC,
  SMOKE_EXHALE_PUFFS,
  SMOKE_EXHALE_RISE_PX_PER_SEC,
  SMOKE_EXHALE_SPREAD_PX,
  SMOKE_EXHALE_STAGGER_SEC,
  SMOKE_FIRST_DRAG_DELAY_SEC,
  SMOKE_INHALE_SEC,
  SMOKE_LIGHT_UP_SEC,
  SMOKE_LIGHTER_FRAME_SEC,
  SMOKE_PUFF_DRIFT_PX,
  SMOKE_PUFF_MAX_SIZE_PX,
  SMOKE_PUFF_START_ALPHA,
  SMOKE_PUFF_WOBBLE_RAD_PER_SEC,
  SMOKE_STUB_OUT_SEC,
  SMOKE_WIND_PX_PER_SEC,
  SMOKE_WISP_ALPHA,
  SMOKE_WISP_INTERVAL_SEC,
  SMOKE_WISP_LIFETIME_SEC,
  SMOKE_WISP_RISE_PX_PER_SEC,
} from '../../constants.js';
import type { LookMetrics } from '../agentLook.js';
import { lookMetrics } from '../agentLook.js';
import type { Character, SpriteData } from '../types.js';
import { Direction } from '../types.js';
import { ZoneLabel } from '../zones.js';
import { isSettledAtZoneTarget } from './characters.js';

/** Standing at a Smoke spot (lighting up, smoking or stubbing out). */
export function isSmoking(ch: Character): boolean {
  return ch.zoneTarget?.zone === ZoneLabel.SMOKE && isSettledAtZoneTarget(ch);
}

/** The hand's place on a character: the chibi's by default, a Clawd's when
 *  the renderer passes its metrics (agentLook.ts metricsOf). */
export type HandMetrics = Pick<LookMetrics, 'handRise' | 'reachFront' | 'reachSide'>;
export type MouthMetrics = Pick<LookMetrics, 'mouthRise' | 'mouthSide' | 'mouthBackExtra'>;

/** The cigarette: paper px then the lit tip, held at the hand (px cover [dx, dx+1)). */
export function cigarettePixels(
  dir: Direction,
  hand: HandMetrics = lookMetrics('classic'),
): {
  paper: Array<{ dx: number; dy: number }>;
  tip: { dx: number; dy: number };
} {
  const dy = -hand.handRise;
  // Sideways it points the way the character faces; otherwise out past its hand.
  const leftward = dir === Direction.LEFT;
  const start =
    dir === Direction.LEFT || dir === Direction.RIGHT ? hand.reachSide : hand.reachFront;
  const xs: number[] = [];
  for (let i = 0; i < CIGARETTE_LENGTH_PX; i++) {
    const right = start + i;
    xs.push(leftward ? -right - 1 : right); // mirrored px for the flipped sprite
  }
  const tipX = xs[xs.length - 1];
  return { paper: xs.slice(0, -1).map((dx) => ({ dx, dy })), tip: { dx: tipX, dy } };
}

/** Where the exhale leaves the face (over the head when facing away). */
export function mouthOffset(
  dir: Direction,
  mouth: MouthMetrics = lookMetrics('classic'),
): { dx: number; dy: number } {
  switch (dir) {
    case Direction.RIGHT:
      return { dx: mouth.mouthSide, dy: -mouth.mouthRise };
    case Direction.LEFT:
      return { dx: -mouth.mouthSide - 1, dy: -mouth.mouthRise };
    case Direction.UP:
      return { dx: 0, dy: -mouth.mouthRise - mouth.mouthBackExtra };
    default:
      return { dx: 0, dy: -mouth.mouthRise };
  }
}

/** One square of smoke: its center offset from where it left, size and alpha. */
export interface SmokePuff {
  dx: number;
  dy: number;
  size: number;
  alpha: number;
}

/** Deterministic noise in [0, 1) for (seed, n): drag jitter, ash flicks. */
function noise(seed: number, n: number): number {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
/** Keeps the ash-flick draws apart from the drag-jitter draws. */
const ASH_NOISE_SALT = 7919;

const FIRST_DRAG_AT = SMOKE_LIGHT_UP_SEC + SMOKE_FIRST_DRAG_DELAY_SEC;

/** When drag `k` (0, 1, ...) starts: one per period, jittered per smoker (`seed`). */
export function dragStart(k: number, seed: number): number {
  return FIRST_DRAG_AT + k * SMOKE_DRAG_PERIOD_SEC + (noise(seed, k) - 0.5) * SMOKE_DRAG_JITTER_SEC;
}

/** The latest drag started by `t`, or -1 before the first. O(1): the jitter is under a period. */
export function latestDrag(t: number, seed: number): number {
  const guess = Math.floor((t - FIRST_DRAG_AT) / SMOKE_DRAG_PERIOD_SEC) + 1;
  for (let k = guess; k >= Math.max(0, guess - 2); k--) {
    if (dragStart(k, seed) <= t) return k;
  }
  return -1;
}

/** The exhale cloud `age` seconds after it left the mouth: a few squares,
 *  staggered, rising and spreading with the wind while they fade. */
function exhaleCloud(age: number, k: number): SmokePuff[] {
  const out: SmokePuff[] = [];
  for (let i = 0; i < SMOKE_EXHALE_PUFFS; i++) {
    const a = age - i * SMOKE_EXHALE_STAGGER_SEC;
    if (a < 0 || a >= SMOKE_EXHALE_LIFETIME_SEC) continue;
    const life = a / SMOKE_EXHALE_LIFETIME_SEC;
    out.push({
      dx:
        SMOKE_WIND_PX_PER_SEC * a +
        (i - (SMOKE_EXHALE_PUFFS - 1) / 2) * SMOKE_EXHALE_SPREAD_PX * life +
        Math.sin(a * SMOKE_PUFF_WOBBLE_RAD_PER_SEC + k + i) * SMOKE_PUFF_DRIFT_PX,
      dy: -a * SMOKE_EXHALE_RISE_PX_PER_SEC,
      size: 1 + (SMOKE_PUFF_MAX_SIZE_PX - 1) * life,
      alpha: SMOKE_PUFF_START_ALPHA * (1 - life),
    });
  }
  return out;
}

/** Thin wisps off the tip at `tLit` seconds after light-up; none born after `lastBirth`. */
function tipWisps(tLit: number, lastBirth: number): SmokePuff[] {
  const out: SmokePuff[] = [];
  if (lastBirth < 0) return out;
  for (let j = Math.floor(lastBirth / SMOKE_WISP_INTERVAL_SEC); j >= 0; j--) {
    const age = tLit - j * SMOKE_WISP_INTERVAL_SEC;
    if (age >= SMOKE_WISP_LIFETIME_SEC) break;
    if (age < 0) continue;
    const life = age / SMOKE_WISP_LIFETIME_SEC;
    out.push({
      dx:
        SMOKE_WIND_PX_PER_SEC * age +
        Math.sin(age * SMOKE_PUFF_WOBBLE_RAD_PER_SEC + j) * SMOKE_PUFF_DRIFT_PX,
      dy: -age * SMOKE_WISP_RISE_PX_PER_SEC,
      size: 1,
      alpha: SMOKE_WISP_ALPHA * (1 - life),
    });
  }
  return out;
}

/** What a smoker shows at one moment of its break. */
export interface SmokeFrame {
  /** Lighting up: the lighter's flick frame (spark, flame); null otherwise. */
  spark: 0 | 1 | null;
  /** The cigarette is drawn (lit, and not yet put out). */
  cigarette: boolean;
  /** Mid-drag: the tip glows brighter. */
  inhaling: boolean;
  /** The ember: 1 while lit, fading to 0 as it is stubbed out. */
  ember: number;
  /** The exhale cloud, relative to the mouth (mouthOffset). */
  exhale: SmokePuff[];
  /** Wisps, relative to the tip. */
  wisps: SmokePuff[];
  /** A falling flick of ash, relative to the tip; null when none is falling. */
  ash: { dx: number; dy: number } | null;
}

/**
 * The smoke break `t` seconds after the character settled at its Smoke spot.
 * `seed` varies the drags per smoker; `stubT` is how far into stubbing out it
 * is (null: still smoking) — nothing new starts after that, and the ember
 * fades; `ashtrayDx` is which way (−1, 0, 1) flicked ash drifts as it falls.
 */
export function smokeFrame(
  t: number,
  seed: number,
  stubT: number | null = null,
  ashtrayDx = 0,
): SmokeFrame {
  if (t < SMOKE_LIGHT_UP_SEC) {
    return {
      spark: (Math.floor(Math.max(0, t) / SMOKE_LIGHTER_FRAME_SEC) % 2) as 0 | 1,
      cigarette: false,
      inhaling: false,
      ember: 0,
      exhale: [],
      wisps: [],
      ash: null,
    };
  }
  const stubbing = stubT !== null;
  const until = stubbing ? t - stubT : t; // the timeline stops where the stub-out began
  const ember = stubbing ? Math.max(0, 1 - stubT / SMOKE_STUB_OUT_SEC) : 1;
  const k = latestDrag(until, seed);
  const drag = k >= 0 ? dragStart(k, seed) : -Infinity;
  const inhaling = !stubbing && t - drag < SMOKE_INHALE_SEC;
  const exhaleAge = t - (drag + SMOKE_INHALE_SEC + SMOKE_EXHALE_DELAY_SEC);
  let ash: SmokeFrame['ash'] = null;
  if (!stubbing && k >= 0 && noise(seed + ASH_NOISE_SALT, k) < SMOKE_ASH_FLICK_CHANCE) {
    const falling = t - (drag + SMOKE_ASH_FLICK_AFTER_SEC);
    if (falling >= 0 && falling < SMOKE_ASH_FALL_SEC) {
      const p = falling / SMOKE_ASH_FALL_SEC;
      ash = {
        dx: Math.round(Math.sign(ashtrayDx) * SMOKE_ASH_DRIFT_PX * p),
        dy: Math.round(SMOKE_ASH_FALL_PX * p),
      };
    }
  }
  return {
    spark: null,
    cigarette: ember > 0,
    inhaling,
    ember,
    exhale: k >= 0 ? exhaleCloud(exhaleAge, k) : [],
    wisps: tipWisps(t - SMOKE_LIGHT_UP_SEC, until - SMOKE_LIGHT_UP_SEC),
    ash,
  };
}

/** The way to face to look from one tile toward another (the longer axis wins). */
export function directionToward(
  from: { col: number; row: number },
  to: { col: number; row: number },
): Direction {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (dc !== 0 && Math.abs(dc) >= Math.abs(dr)) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr > 0 ? Direction.DOWN : Direction.UP;
}

/**
 * Smokers in company turn to each other: with two or more, each faces the
 * nearest other one (ties: the lower id) instead of the ashtray. Empty for a
 * lone smoker, who keeps facing the ashtray.
 */
export function socialFacing(
  smokers: ReadonlyArray<{ id: number; col: number; row: number }>,
): Map<number, Direction> {
  const out = new Map<number, Direction>();
  if (smokers.length < 2) return out;
  for (const me of smokers) {
    let nearest: { id: number; col: number; row: number } | null = null;
    let nearestDist = Infinity;
    for (const other of smokers) {
      if (other.id === me.id) continue;
      const d = Math.abs(other.col - me.col) + Math.abs(other.row - me.row);
      if (d < nearestDist || (d === nearestDist && nearest !== null && other.id < nearest.id)) {
        nearest = other;
        nearestDist = d;
      }
    }
    if (nearest) out.set(me.id, directionToward(me, nearest));
  }
  return out;
}

/** Butts in the ashtray for the longest current wait on the user (null: nobody waits). */
export function ashtrayButtCount(longestWaitSec: number | null): number {
  if (longestWaitSec === null || longestWaitSec < 0) return 0;
  return Math.min(ASHTRAY_BUTT_SLOTS.length, Math.floor(longestWaitSec / ASHTRAY_BUTT_WAIT_SEC));
}

/** A butt: paper, then filter. One shared sprite, so the sprite cache keeps one canvas. */
export const ASHTRAY_BUTT_SPRITE: SpriteData = [[CIGARETTE_PAPER_COLOR, CIGARETTE_FILTER_COLOR]];
