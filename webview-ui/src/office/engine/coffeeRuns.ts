/**
 * Café coffee runs (docs/office/DESIGN.md, "short gap between tools,
 * sometimes → Café counter, then back"): while an agent works, at a natural
 * gap between tools it sometimes walks to the Café counter, stands there a
 * few seconds, and carries a cup back to its desk. Pure, like smokeBreaks.ts:
 * the scheduler steps per frame on an injected clock and RNG, so the gap, the
 * chance, the cooldown and the run's length are testable — plus where the
 * counter is and where the cup is drawn.
 */

import {
  COFFEE_CUP_CARRY_SEC,
  COFFEE_CUP_COFFEE_COLOR,
  COFFEE_CUP_COLOR,
  COFFEE_MACHINE_TYPE_PREFIX,
  COFFEE_RUN_CHANCE,
  COFFEE_RUN_COOLDOWN_SEC,
  COFFEE_RUN_GAP_SEC,
  COFFEE_RUN_MAX_SEC,
  COFFEE_RUN_STAND_MIN_SEC,
  COFFEE_RUN_STAND_RANGE_SEC,
} from '../../constants.js';
import type { LookMetrics } from '../agentLook.js';
import { lookMetrics } from '../agentLook.js';
import { Direction } from '../types.js';
import type { FootprintOf, ZonePlace } from '../zones.js';
import { spotKey, ZoneLabel } from '../zones.js';

// ── The scheduler ─────────────────────────────────────────────

export interface CoffeeRunState {
  /** A tool was live since the last gap began (a gap is between tools). */
  toolWasLive: boolean;
  /** When the current gap between tools began; null while a tool is live. */
  gapSince: number | null;
  /** This gap has had its chance already. */
  gapRolled: boolean;
  /** When the last run began (the cooldown runs from it). */
  lastRunAt: number | null;
  /** The run under way: when it began and how long to stand at the counter. */
  run: { startedAt: number; standSec: number } | null;
  /** Carrying a cup back until then; null when not. */
  cupUntil: number | null;
}

export const NO_COFFEE_RUN: CoffeeRunState = {
  toolWasLive: false,
  gapSince: null,
  gapRolled: false,
  lastRunAt: null,
  run: null,
  cupUntil: null,
};

export interface CoffeeRunInput {
  /** Office-clock seconds. */
  now: number;
  /** Working (agentStatus active). A turn end ends any run. */
  active: boolean;
  /** Live (not done) tools right now. */
  liveTools: number;
  /** A permission, a question, a test run, asleep, or a smoke: no coffee. */
  blocked: boolean;
  /** A counter place is free (no run starts otherwise). */
  counterFree: boolean;
  /** Seconds it has stood at the counter so far (0 until it gets there). */
  atCounterSec: number;
}

/** One step of the coffee-run scheduler. `random` returns [0, 1) like Math.random. */
export function stepCoffeeRun(
  state: CoffeeRunState,
  input: CoffeeRunInput,
  random: () => number,
): CoffeeRunState {
  const { now } = input;
  let { toolWasLive, gapSince, gapRolled, lastRunAt, run, cupUntil } = state;
  if (cupUntil !== null && now >= cupUntil) cupUntil = null;

  if (!input.active) {
    // The turn ended: no gap to fill, and any run is called off.
    toolWasLive = false;
    gapSince = null;
    gapRolled = false;
    run = null;
  } else {
    if (input.liveTools > 0) {
      toolWasLive = true;
      gapSince = null;
      gapRolled = false;
    } else if (toolWasLive) {
      toolWasLive = false;
      gapSince = now; // a tool just finished: a gap between tools begins
    }
    if (run) {
      if (input.blocked || now - run.startedAt > COFFEE_RUN_MAX_SEC) {
        run = null; // called away (or it couldn't get there): no coffee
      } else if (input.atCounterSec >= run.standSec) {
        run = null; // got it: back to the desk, cup in hand
        cupUntil = now + COFFEE_CUP_CARRY_SEC;
      }
    } else if (
      !input.blocked &&
      input.counterFree &&
      !gapRolled &&
      gapSince !== null &&
      now - gapSince > COFFEE_RUN_GAP_SEC &&
      (lastRunAt === null || now - lastRunAt >= COFFEE_RUN_COOLDOWN_SEC)
    ) {
      gapRolled = true; // one chance per gap
      if (random() < COFFEE_RUN_CHANCE) {
        lastRunAt = now;
        run = {
          startedAt: now,
          standSec: COFFEE_RUN_STAND_MIN_SEC + random() * COFFEE_RUN_STAND_RANGE_SEC,
        };
      }
    }
  }

  if (
    toolWasLive === state.toolWasLive &&
    gapSince === state.gapSince &&
    gapRolled === state.gapRolled &&
    lastRunAt === state.lastRunAt &&
    run === state.run &&
    cupUntil === state.cupUntil
  ) {
    return state;
  }
  return { toolWasLive, gapSince, gapRolled, lastRunAt, run, cupUntil };
}

/** On a coffee run right now (walking there or standing at the counter)? */
export function onCoffeeRun(state: CoffeeRunState): boolean {
  return state.run !== null;
}

/** Carrying a cup back right now? */
export function carryingCup(state: CoffeeRunState, now: number): boolean {
  return state.cupUntil !== null && now < state.cupUntil;
}

/** A small seeded PRNG (mulberry32): [0, 1), the same sequence for a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The counter ───────────────────────────────────────────────

export interface CounterInput {
  cols: number;
  rows: number;
  areaTiles?: ReadonlyArray<string | null>;
  furniture: ReadonlyArray<{ type: string; col: number; row: number }>;
  footprint: FootprintOf;
  walkable: (col: number, row: number) => boolean;
}

/**
 * Where a coffee run stands: the tile in front of (below) each Café coffee
 * machine, facing it; else a free side of it. Empty without a machine in the
 * Café (the caller falls back to the Café's own places).
 */
export function cafeCounterSpots(input: CounterInput): ZonePlace[] {
  const { cols, rows, areaTiles } = input;
  if (!areaTiles || areaTiles.length === 0) return [];
  const inCafe = (col: number, row: number): boolean =>
    col >= 0 &&
    row >= 0 &&
    col < cols &&
    row < rows &&
    (areaTiles[row * cols + col] ?? '').trim().toLowerCase() === ZoneLabel.CAFE.toLowerCase();
  const spot = (col: number, row: number, facing: Direction): ZonePlace => ({
    zone: ZoneLabel.CAFE,
    key: spotKey(col, row),
    col,
    row,
    facing,
    sit: false,
  });
  const front: ZonePlace[] = [];
  const sides: ZonePlace[] = [];
  const seen = new Set<string>();
  const add = (list: ZonePlace[], col: number, row: number, facing: Direction) => {
    const k = `${col},${row}`;
    if (seen.has(k) || !inCafe(col, row) || !input.walkable(col, row)) return;
    seen.add(k);
    list.push(spot(col, row, facing));
  };
  for (const item of input.furniture) {
    if (!item.type.startsWith(COFFEE_MACHINE_TYPE_PREFIX)) continue;
    const fp = input.footprint(item.type) ?? { w: 1, h: 1 };
    let mine = false;
    for (let dr = 0; dr < fp.h && !mine; dr++) {
      for (let dc = 0; dc < fp.w && !mine; dc++) mine = inCafe(item.col + dc, item.row + dr);
    }
    if (!mine) continue;
    // In front of it: the row below its footprint — on a counter, below the counter.
    for (let dc = 0; dc < fp.w; dc++) {
      for (let down = fp.h; down <= fp.h + 2; down++) {
        const col = item.col + dc;
        const row = item.row + down;
        if (input.walkable(col, row) && inCafe(col, row)) {
          add(front, col, row, Direction.UP);
          break;
        }
      }
    }
    for (let dr = 0; dr < fp.h; dr++) {
      add(sides, item.col - 1, item.row + dr, Direction.RIGHT);
      add(sides, item.col + fp.w, item.row + dr, Direction.LEFT);
    }
  }
  return front.length > 0 ? front : sides;
}

// ── The cup ───────────────────────────────────────────────────

/** The cup's px at the hand, from the feet anchor (px cover [dx, dx+1)):
 *  2 wide, 3 tall, the coffee showing on top. Mirrors the cigarette's hand —
 *  the chibi's by default, a Clawd's when the renderer passes its metrics. */
export function cupPixels(
  dir: Direction,
  hand: Pick<LookMetrics, 'handRise' | 'reachFront' | 'reachSide'> = lookMetrics('classic'),
): Array<{ dx: number; dy: number; color: string }> {
  const side = dir === Direction.LEFT || dir === Direction.RIGHT;
  const reach = side ? hand.reachSide : hand.reachFront - 1;
  const left = dir === Direction.LEFT ? -reach - 2 : reach;
  const top = -hand.handRise - 1;
  const out: Array<{ dx: number; dy: number; color: string }> = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 2; x++) {
      out.push({
        dx: left + x,
        dy: top + y,
        color: y === 0 ? COFFEE_CUP_COFFEE_COLOR : COFFEE_CUP_COLOR,
      });
    }
  }
  return out;
}
