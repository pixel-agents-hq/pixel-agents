/**
 * The smoke break, pure (zoneEffects.ts, smokeBreaks.ts): the timeline of a
 * cigarette at a Smoke spot — lighter flick, drags every ~4-6 s (an inhale
 * glow, then an exhale cloud on the shared wind), wisps between drags, ash
 * flicks, the stub-out — who faces whom when several smoke, how full the
 * ashtray is, and the mid-work break scheduler (eligibility, chance,
 * cooldown, length) on an injected clock and RNG.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import {
  ASHTRAY_BUTT_SLOTS,
  ASHTRAY_BUTT_WAIT_SEC,
  SMOKE_ASH_FLICK_AFTER_SEC,
  SMOKE_BREAK_AFTER_WORK_SEC,
  SMOKE_BREAK_COOLDOWN_SEC,
  SMOKE_BREAK_GAP_SEC,
  SMOKE_BREAK_MIN_SEC,
  SMOKE_BREAK_RANGE_SEC,
  SMOKE_EXHALE_DELAY_SEC,
  SMOKE_INHALE_SEC,
  SMOKE_LIGHT_UP_SEC,
  SMOKE_LIGHTER_FRAME_SEC,
  SMOKE_STUB_OUT_SEC,
} from '../src/constants.js';
import type { SmokeBreakInput, SmokeBreakState } from '../src/office/engine/smokeBreaks.js';
import { NO_SMOKE_BREAK, onSmokeBreak, stepSmokeBreak } from '../src/office/engine/smokeBreaks.js';
import {
  ashtrayButtCount,
  cigarettePixels,
  dragStart,
  latestDrag,
  mouthOffset,
  smokeFrame,
  socialFacing,
} from '../src/office/engine/zoneEffects.js';
import { Direction } from '../src/office/types.js';

const SEED = 3;

describe('lighting up', () => {
  it('the lighter flicks (two frames) before the cigarette appears', () => {
    const first = smokeFrame(0, SEED);
    const second = smokeFrame(SMOKE_LIGHTER_FRAME_SEC + 0.01, SEED);
    expect(first.spark).toBe(0);
    expect(second.spark).toBe(1);
    expect(first.cigarette).toBe(false);
    const lit = smokeFrame(SMOKE_LIGHT_UP_SEC + 0.01, SEED);
    expect(lit.spark).toBeNull();
    expect(lit.cigarette).toBe(true);
    expect(lit.ember).toBe(1);
  });
});

describe('the drags', () => {
  it('come about every 4-6 s, varying per smoker', () => {
    for (const seed of [1, 2, 3, 17, 99]) {
      for (let k = 0; k < 50; k++) {
        const gap = dragStart(k + 1, seed) - dragStart(k, seed);
        expect(gap).toBeGreaterThanOrEqual(4);
        expect(gap).toBeLessThanOrEqual(6);
      }
    }
    expect(dragStart(5, 1)).not.toBe(dragStart(5, 2));
  });

  it('latestDrag finds the drag under way, in O(1), however long the break', () => {
    for (const t of [0, 3, 10, 61.5, 3600]) {
      const k = latestDrag(t, SEED);
      if (k >= 0) expect(dragStart(k, SEED)).toBeLessThanOrEqual(t);
      expect(dragStart(k + 1, SEED)).toBeGreaterThan(t);
    }
    expect(latestDrag(SMOKE_LIGHT_UP_SEC, SEED)).toBe(-1); // no drag yet
  });

  it('an inhale makes the tip glow for a moment, then the exhale leaves the mouth', () => {
    const drag = dragStart(2, SEED);
    expect(smokeFrame(drag + 0.1, SEED).inhaling).toBe(true);
    expect(smokeFrame(drag + SMOKE_INHALE_SEC + 0.05, SEED).inhaling).toBe(false);
    expect(smokeFrame(drag + 0.1, SEED).exhale).toEqual([]);
    const exhaleAt = drag + SMOKE_INHALE_SEC + SMOKE_EXHALE_DELAY_SEC;
    const early = smokeFrame(exhaleAt + 0.2, SEED).exhale;
    const late = smokeFrame(exhaleAt + 1.2, SEED).exhale;
    expect(early.length).toBeGreaterThan(0);
    // It rises, drifts with the wind (to the right), grows and fades.
    expect(late[0].dy).toBeLessThan(early[0].dy);
    expect(late[0].dx).toBeGreaterThan(early[0].dx);
    expect(late[0].size).toBeGreaterThan(early[0].size);
    expect(late[0].alpha).toBeLessThan(early[0].alpha);
    // Gone before the next drag.
    expect(smokeFrame(dragStart(3, SEED) - 0.01, SEED).exhale).toEqual([]);
  });

  it('between drags, thin faint wisps rise off the tip', () => {
    const between = smokeFrame(dragStart(2, SEED) + 3.5, SEED);
    expect(between.wisps.length).toBeGreaterThan(0);
    for (const w of between.wisps) {
      expect(w.size).toBe(1);
      expect(w.alpha).toBeLessThan(0.5);
      expect(w.dy).toBeLessThanOrEqual(0);
    }
  });

  it('now and then ash is flicked: a px falls from the tip toward the ashtray', () => {
    let flicks = 0;
    for (let k = 0; k < 40; k++) {
      const at = dragStart(k, SEED) + SMOKE_ASH_FLICK_AFTER_SEC;
      const start = smokeFrame(at + 0.05, SEED, null, 1).ash;
      const later = smokeFrame(at + 0.4, SEED, null, 1).ash;
      if (!start) continue;
      flicks++;
      expect(later!.dy).toBeGreaterThan(start.dy); // falling
      expect(later!.dx).toBeGreaterThanOrEqual(start.dx); // toward the tray (to the right)
      expect(smokeFrame(at + 1, SEED, null, 1).ash).toBeNull(); // landed
    }
    expect(flicks).toBeGreaterThan(3); // occasionally...
    expect(flicks).toBeLessThan(30); // ...not every drag
  });
});

describe('stubbing out', () => {
  it('the ember fades, nothing new starts, and the cigarette is gone', () => {
    const t = dragStart(4, SEED) + 3;
    const half = smokeFrame(t, SEED, SMOKE_STUB_OUT_SEC / 2);
    expect(half.cigarette).toBe(true);
    expect(half.ember).toBeCloseTo(0.5);
    expect(half.inhaling).toBe(false);
    expect(half.ash).toBeNull();
    // No drag after the stub-out began, however long it's been.
    const later = smokeFrame(t + 10, SEED, 10 + SMOKE_STUB_OUT_SEC / 2);
    expect(later.exhale).toEqual([]);
    expect(smokeFrame(t, SEED, SMOKE_STUB_OUT_SEC).cigarette).toBe(false);
  });
});

describe('where things are on the smoker', () => {
  it('the cigarette is 3 px at hand height, lit at the far end, mirrored facing left', () => {
    const right = cigarettePixels(Direction.RIGHT);
    const left = cigarettePixels(Direction.LEFT);
    expect(right.paper).toHaveLength(2);
    expect(right.tip.dx).toBeGreaterThan(Math.max(...right.paper.map((p) => p.dx)));
    expect(left.tip.dx).toBe(-right.tip.dx - 1);
    expect(right.tip.dy).toBeLessThan(0);
  });

  it('the exhale leaves the face: in front of it sideways, over the head facing away', () => {
    expect(mouthOffset(Direction.RIGHT).dx).toBeGreaterThan(0);
    expect(mouthOffset(Direction.LEFT).dx).toBeLessThan(0);
    expect(mouthOffset(Direction.UP).dy).toBeLessThan(mouthOffset(Direction.DOWN).dy);
  });
});

describe('smokers in company', () => {
  it('a lone smoker keeps facing the ashtray', () => {
    expect(socialFacing([{ id: 1, col: 10, row: 2 }]).size).toBe(0);
  });

  it('two face each other', () => {
    const facing = socialFacing([
      { id: 1, col: 10, row: 2 },
      { id: 2, col: 12, row: 2 },
    ]);
    expect(facing.get(1)).toBe(Direction.RIGHT);
    expect(facing.get(2)).toBe(Direction.LEFT);
  });

  it('each faces the nearest other one', () => {
    const facing = socialFacing([
      { id: 1, col: 11, row: 1 },
      { id: 2, col: 10, row: 3 },
      { id: 3, col: 11, row: 4 },
    ]);
    expect(facing.get(3)).toBe(Direction.LEFT); // 2 is 2 away, 1 is 3 away
    expect(facing.get(1)).toBe(Direction.DOWN); // 2 (3 away) beats 3 (3 away) on id, mostly below
  });
});

describe('the ashtray fills while people wait', () => {
  it(`one butt per ${ASHTRAY_BUTT_WAIT_SEC / 60} min of the longest wait, capped, empty when nobody waits`, () => {
    expect(ashtrayButtCount(null)).toBe(0);
    expect(ashtrayButtCount(ASHTRAY_BUTT_WAIT_SEC - 1)).toBe(0);
    expect(ashtrayButtCount(ASHTRAY_BUTT_WAIT_SEC)).toBe(1);
    expect(ashtrayButtCount(2.5 * ASHTRAY_BUTT_WAIT_SEC)).toBe(2);
    expect(ashtrayButtCount(100 * ASHTRAY_BUTT_WAIT_SEC)).toBe(ASHTRAY_BUTT_SLOTS.length);
  });
});

describe('the mid-work break scheduler', () => {
  const always = () => 0; // every chance taken, shortest break
  const working = (now: number, over: Partial<SmokeBreakInput> = {}): SmokeBreakInput => ({
    now,
    active: true,
    liveTools: 0,
    blocked: false,
    smokeFree: true,
    ...over,
  });
  /** Step from t0 to t1 once a second; tools live except in [gapFrom, ∞). */
  const run = (
    state: SmokeBreakState,
    from: number,
    to: number,
    input: (t: number) => SmokeBreakInput,
    random: () => number,
  ) => {
    let s = state;
    for (let t = from; t <= to; t += 1) s = stepSmokeBreak(s, input(t), random);
    return s;
  };
  const AFTER = SMOKE_BREAK_AFTER_WORK_SEC;

  it(`no break before ${AFTER / 60} min of continuous work`, () => {
    const s = run(NO_SMOKE_BREAK, 0, AFTER - 10, (t) => working(t), always);
    expect(onSmokeBreak(s, AFTER - 10)).toBe(false);
  });

  it('after that, at a gap of over 3 s with no live tool, a break of 60-90 s', () => {
    // Busy (a tool live) through the 40 minutes, then a gap.
    let s = run(NO_SMOKE_BREAK, 0, AFTER, (t) => working(t, { liveTools: 1 }), always);
    expect(onSmokeBreak(s, AFTER)).toBe(false); // no gap yet
    s = run(s, AFTER + 1, AFTER + SMOKE_BREAK_GAP_SEC, (t) => working(t), always);
    expect(onSmokeBreak(s, AFTER + SMOKE_BREAK_GAP_SEC)).toBe(false); // the gap is too short
    s = run(
      s,
      AFTER + SMOKE_BREAK_GAP_SEC + 1,
      AFTER + SMOKE_BREAK_GAP_SEC + 2,
      (t) => working(t),
      always,
    );
    const begun = s.lastBreakAt!;
    expect(onSmokeBreak(s, begun)).toBe(true);
    const length = s.breakUntil! - begun;
    expect(length).toBeGreaterThanOrEqual(SMOKE_BREAK_MIN_SEC);
    expect(length).toBeLessThanOrEqual(SMOKE_BREAK_MIN_SEC + SMOKE_BREAK_RANGE_SEC);
    // It ends on time even while still working (tools live again).
    s = run(s, begun + 1, begun + length + 1, (t) => working(t, { liveTools: 1 }), always);
    expect(onSmokeBreak(s, begun + length + 1)).toBe(false);
  });

  it('one chance per gap: a missed roll waits for the next gap', () => {
    const rolls = [0.9, 0.1]; // miss, then hit
    let i = 0;
    const random = () => rolls[Math.min(i++, rolls.length - 1)];
    let s = run(NO_SMOKE_BREAK, 0, AFTER + 10, (t) => working(t), random);
    expect(s.breakUntil).toBeNull(); // rolled once (missed), not every frame
    expect(i).toBe(1);
    s = stepSmokeBreak(s, working(AFTER + 11, { liveTools: 1 }), random); // a tool: the gap ends
    s = run(s, AFTER + 12, AFTER + 20, (t) => working(t), random);
    expect(onSmokeBreak(s, AFTER + 20)).toBe(true);
  });

  it(`at most once per ${SMOKE_BREAK_COOLDOWN_SEC / 60} min`, () => {
    let s = run(NO_SMOKE_BREAK, 0, AFTER + 10, (t) => working(t), always);
    const first = s.lastBreakAt!;
    // Gaps keep coming: none of them starts another break within the hour.
    for (let t = first + 1; t < first + SMOKE_BREAK_COOLDOWN_SEC; t += 1) {
      s = stepSmokeBreak(s, working(t, { liveTools: t % 20 < 10 ? 1 : 0 }), always);
      expect(s.lastBreakAt).toBe(first);
    }
    s = run(
      s,
      first + SMOKE_BREAK_COOLDOWN_SEC,
      first + SMOKE_BREAK_COOLDOWN_SEC + 30,
      (t) => working(t, { liveTools: t % 20 < 10 ? 1 : 0 }),
      always,
    );
    expect(s.lastBreakAt).toBeGreaterThan(first);
  });

  it('never while blocked (a permission, a question, asleep); a request ends a break', () => {
    let s = run(NO_SMOKE_BREAK, 0, AFTER + 10, (t) => working(t, { blocked: true }), always);
    expect(s.lastBreakAt).toBeNull();
    s = run(s, AFTER + 11, AFTER + 20, (t) => working(t), always);
    expect(onSmokeBreak(s, AFTER + 20)).toBe(true);
    s = stepSmokeBreak(s, working(AFTER + 21, { blocked: true }), always);
    expect(onSmokeBreak(s, AFTER + 21)).toBe(false);
  });

  it('never with the Smoke terrace full (no Cafe overflow for a break)', () => {
    const s = run(NO_SMOKE_BREAK, 0, AFTER + 10, (t) => working(t, { smokeFree: false }), always);
    expect(s.lastBreakAt).toBeNull();
  });

  it('a turn end resets the stretch of work', () => {
    let s = run(NO_SMOKE_BREAK, 0, AFTER - 60, (t) => working(t), always);
    s = stepSmokeBreak(s, working(AFTER - 59, { active: false }), always);
    expect(s.workingSince).toBeNull();
    s = run(s, AFTER - 58, AFTER + 60, (t) => working(t), always);
    expect(s.lastBreakAt).toBeNull(); // only ~2 min of work since
  });

  it('with the real chance, breaks are occasional', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let gapsRolled = 0;
    let breaks = 0;
    for (let trial = 0; trial < 200; trial++) {
      let s = run(NO_SMOKE_BREAK, 0, AFTER, (t) => working(t, { liveTools: 1 }), random);
      s = run(s, AFTER + 1, AFTER + 5, (t) => working(t), random);
      gapsRolled += s.gapRolled ? 1 : 0;
      breaks += s.lastBreakAt !== null ? 1 : 0;
    }
    expect(gapsRolled).toBe(200);
    expect(breaks).toBeGreaterThan(20);
    expect(breaks).toBeLessThan(90); // ~25%
  });
});
