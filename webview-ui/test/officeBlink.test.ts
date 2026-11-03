import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  BLINK_FOCUS_STRETCH,
  BLINK_GAP_MAX_SEC,
  BLINK_GAP_MIN_SEC,
  BLINK_SHUT_SEC,
} from '../src/constants.js';
import { blinkGap, startBlink, tickBlink } from '../src/office/engine/blink.js';

/** A seeded random (mulberry32), so the runs are repeatable. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulate `seconds` at 60 fps; the blinks' start times and shut lengths. */
function run(seconds: number, focused: boolean, rand: () => number) {
  const b = startBlink(rand);
  const dt = 1 / 60;
  const blinks: Array<{ at: number; shut: number }> = [];
  let shutFor = 0;
  for (let t = 0; t < seconds; t += dt) {
    const shut = tickBlink(b, dt, focused, rand);
    if (shut) shutFor += dt;
    if (shut && shutFor === dt) blinks.push({ at: t, shut: 0 });
    if (!shut && shutFor > 0) {
      blinks[blinks.length - 1].shut = shutFor;
      shutFor = 0;
    }
  }
  return blinks;
}

test('gaps stay within their floor and cap, and focus stretches them', () => {
  const rand = seeded(1);
  for (let i = 0; i < 2000; i++) {
    const g = blinkGap(false, rand);
    assert.ok(g >= BLINK_GAP_MIN_SEC && g <= BLINK_GAP_MAX_SEC);
  }
  const r = () => 0.5;
  assert.equal(blinkGap(true, r), blinkGap(false, r) * BLINK_FOCUS_STRETCH);
});

test('blinks are brief and come at irregular times, some in quick pairs', () => {
  const blinks = run(600, false, seeded(7));
  assert.ok(blinks.length > 60 && blinks.length < 300, `${blinks.length} blinks in 10 min`);
  for (const b of blinks.slice(0, -1)) {
    assert.ok(b.shut <= BLINK_SHUT_SEC[1] + 1 / 30, `shut ${b.shut}`);
  }
  const gaps = blinks.slice(1).map((b, i) => b.at - blinks[i].at);
  const distinct = new Set(gaps.map((g) => Math.round(g * 10)));
  assert.ok(distinct.size > 20, 'gaps vary');
  assert.ok(
    gaps.some((g) => g < 0.6),
    'a double blink',
  );
  assert.ok(
    gaps.some((g) => g > 6),
    'a long stare',
  );
});

test('two characters started together blink out of step', () => {
  const rand = seeded(3);
  const a = run(30, false, rand).map((b) => Math.round(b.at * 10));
  const b = run(30, false, rand).map((b) => Math.round(b.at * 10));
  assert.notDeepEqual(a, b);
});
