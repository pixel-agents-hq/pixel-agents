/**
 * Office blinks: each character keeps its own clock, so the room never blinks in step.
 * Gaps are random and skewed (mostly a few seconds, now and then much longer), some
 * blinks come in pairs, and characters working at their desk blink less often.
 */

import {
  BLINK_DOUBLE_CHANCE,
  BLINK_DOUBLE_GAP_SEC,
  BLINK_FOCUS_STRETCH,
  BLINK_GAP_MAX_SEC,
  BLINK_GAP_MEAN_SEC,
  BLINK_GAP_MIN_SEC,
  BLINK_SHUT_SEC,
} from '../../constants.js';
import type { Blinker } from '../types.js';

type Rand = () => number;

const between = ([min, max]: readonly [number, number], rand: Rand) => min + rand() * (max - min);

/** The wait before the next blink: a floor, then an exponential wait, capped. */
export function blinkGap(focused: boolean, rand: Rand = Math.random): number {
  const wait = -Math.log(1 - rand()) * BLINK_GAP_MEAN_SEC;
  const gap = Math.min(BLINK_GAP_MIN_SEC + wait, BLINK_GAP_MAX_SEC);
  return focused ? gap * BLINK_FOCUS_STRETCH : gap;
}

/** A fresh clock, its first blink anywhere in a normal gap (so new characters are out of step). */
export function startBlink(rand: Rand = Math.random): Blinker {
  return { blinkIn: rand() * blinkGap(false, rand), blinkShut: 0 };
}

/** Advance a character's blink by `dt` seconds; returns whether its eyes are shut. */
export function tickBlink(
  b: Blinker,
  dt: number,
  focused: boolean,
  rand: Rand = Math.random,
): boolean {
  if (b.blinkShut > 0) {
    b.blinkShut = Math.max(0, b.blinkShut - dt);
    return b.blinkShut > 0;
  }
  b.blinkIn -= dt;
  if (b.blinkIn > 0) return false;
  b.blinkShut = between(BLINK_SHUT_SEC, rand);
  // The next wait starts once the eyes open again (blinkIn doesn't run while shut).
  b.blinkIn =
    rand() < BLINK_DOUBLE_CHANCE ? between(BLINK_DOUBLE_GAP_SEC, rand) : blinkGap(focused, rand);
  return true;
}
