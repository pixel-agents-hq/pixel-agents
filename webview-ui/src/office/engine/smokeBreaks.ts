/**
 * Mid-work smoke breaks (case B of the living office): after a long stretch
 * of continuous work, an agent sometimes steps out for a cigarette at a
 * natural gap between tools, then goes back to its desk even if it is still
 * working. Pure: the state steps per frame on an injected clock and RNG, so
 * eligibility, the chance, the cooldown and the break's length are testable.
 *
 * (Case A, a long-running shell command, needs no state: zoneRouting reads it
 * off the live tools.)
 */

import {
  SMOKE_BREAK_AFTER_WORK_SEC,
  SMOKE_BREAK_CHANCE,
  SMOKE_BREAK_COOLDOWN_SEC,
  SMOKE_BREAK_GAP_SEC,
  SMOKE_BREAK_MIN_SEC,
  SMOKE_BREAK_RANGE_SEC,
} from '../../constants.js';

export interface SmokeBreakState {
  /** When continuous work (no turn end) began; null between turns. */
  workingSince: number | null;
  /** Since when no tool has been live; null while one is. */
  noToolSince: number | null;
  /** This gap between tools has had its chance already. */
  gapRolled: boolean;
  /** When the last break began (the cooldown runs from it). */
  lastBreakAt: number | null;
  /** When the current break ends; null when not on one. */
  breakUntil: number | null;
}

export const NO_SMOKE_BREAK: SmokeBreakState = {
  workingSince: null,
  noToolSince: null,
  gapRolled: false,
  lastBreakAt: null,
  breakUntil: null,
};

export interface SmokeBreakInput {
  /** Office-clock seconds. */
  now: number;
  /** Working (agentStatus active). A turn end ends the stretch of work. */
  active: boolean;
  /** Live (not done) tools right now. */
  liveTools: number;
  /** A permission, a question to the user, or asleep: no break. */
  blocked: boolean;
  /** A Smoke spot is free: a break never overflows into the Cafe. */
  smokeFree: boolean;
}

/** One step of the break scheduler. `random` returns [0, 1) like Math.random. */
export function stepSmokeBreak(
  state: SmokeBreakState,
  input: SmokeBreakInput,
  random: () => number,
): SmokeBreakState {
  const { now } = input;
  if (!input.active) {
    // The turn ended: the stretch of work (and any break in it) is over.
    if (
      state.workingSince === null &&
      state.noToolSince === null &&
      !state.gapRolled &&
      state.breakUntil === null
    ) {
      return state;
    }
    return { ...state, workingSince: null, noToolSince: null, gapRolled: false, breakUntil: null };
  }
  const workingSince = state.workingSince ?? now;
  let breakUntil = state.breakUntil;
  // A break ends on time — back to the desk even if still working — or the
  // moment someone needs the user.
  if (breakUntil !== null && (now >= breakUntil || input.blocked)) breakUntil = null;
  const toolLive = input.liveTools > 0;
  const noToolSince = toolLive ? null : (state.noToolSince ?? now);
  let gapRolled = toolLive ? false : state.gapRolled;
  let lastBreakAt = state.lastBreakAt;
  const eligible =
    breakUntil === null &&
    !input.blocked &&
    input.smokeFree &&
    !gapRolled &&
    noToolSince !== null &&
    now - noToolSince > SMOKE_BREAK_GAP_SEC &&
    now - workingSince >= SMOKE_BREAK_AFTER_WORK_SEC &&
    (lastBreakAt === null || now - lastBreakAt >= SMOKE_BREAK_COOLDOWN_SEC);
  if (eligible) {
    gapRolled = true; // one chance per gap
    if (random() < SMOKE_BREAK_CHANCE) {
      lastBreakAt = now;
      breakUntil = now + SMOKE_BREAK_MIN_SEC + random() * SMOKE_BREAK_RANGE_SEC;
    }
  }
  if (
    workingSince === state.workingSince &&
    noToolSince === state.noToolSince &&
    gapRolled === state.gapRolled &&
    lastBreakAt === state.lastBreakAt &&
    breakUntil === state.breakUntil
  ) {
    return state;
  }
  return { workingSince, noToolSince, gapRolled, lastBreakAt, breakUntil };
}

/** On a break right now? */
export function onSmokeBreak(state: SmokeBreakState, now: number): boolean {
  return state.breakUntil !== null && now < state.breakUntil;
}
