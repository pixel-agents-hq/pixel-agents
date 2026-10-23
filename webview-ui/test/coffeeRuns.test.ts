/**
 * Café coffee runs and the receptionist (phase C). The coffee-run scheduler,
 * pure (a gap between tools, the chance, the 30-minute cooldown, how long it
 * stands at the counter, the cup it carries back, never while blocked), then
 * in the office on a seeded RNG; and the receptionist, who sits behind the
 * Entrance's reception desk, waves agents in, and is never an agent.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  COFFEE_CUP_CARRY_SEC,
  COFFEE_RUN_CHANCE,
  COFFEE_RUN_COOLDOWN_SEC,
  COFFEE_RUN_GAP_SEC,
  COFFEE_RUN_MAX_SEC,
  COFFEE_RUN_STAND_MIN_SEC,
  RECEPTIONIST_ID,
  RECEPTIONIST_WAVE_FRAME_SEC,
  RECEPTIONIST_WAVE_SEC,
} from '../src/constants.js';
import { emptyRoomTiles, occupiedTiles } from '../src/office/engine/ambience.js';
import type { CoffeeRunInput, CoffeeRunState } from '../src/office/engine/coffeeRuns.js';
import {
  carryingCup,
  cupPixels,
  NO_COFFEE_RUN,
  onCoffeeRun,
  seededRandom,
  stepCoffeeRun,
} from '../src/office/engine/coffeeRuns.js';
import type { OfficeState } from '../src/office/engine/officeState.js';
import { outlinePixels, waveFrame, waveHandPixels } from '../src/office/engine/receptionist.js';
import { pickDestination } from '../src/office/engine/zoneRouting.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';
import { ZoneLabel } from '../src/office/zones.js';
import { AMBIENCE_FURNITURE, ambienceOffice, installAmbienceCatalog } from './ambienceFixture.js';
import { run } from './livingOfficeFixture.js';

beforeAll(installAmbienceCatalog);

// ── The scheduler, pure ───────────────────────────────────────

const base: CoffeeRunInput = {
  now: 0,
  active: true,
  liveTools: 0,
  blocked: false,
  counterFree: true,
  atCounterSec: 0,
};

/** Step the scheduler through `seconds` at `dt` with the input held. */
function stepFor(
  state: CoffeeRunState,
  from: number,
  seconds: number,
  input: Partial<CoffeeRunInput>,
  random: () => number,
  dt = 0.5,
): { state: CoffeeRunState; now: number } {
  let now = from;
  for (let t = 0; t < seconds; t += dt) {
    now += dt;
    state = stepCoffeeRun(state, { ...base, ...input, now }, random);
  }
  return { state, now };
}

/** A tool runs for 2 s and finishes at `from + 2`. */
function toolThenGap(state: CoffeeRunState, from: number, random: () => number) {
  return stepFor(state, from, 2, { liveTools: 1 }, random);
}

describe('coffee runs: the scheduler', () => {
  const always = () => 0;
  const never = () => 0.99;

  it(`at a gap between tools longer than ${COFFEE_RUN_GAP_SEC} s, not before`, () => {
    let { state, now } = toolThenGap(NO_COFFEE_RUN, 0, always);
    ({ state, now } = stepFor(state, now, COFFEE_RUN_GAP_SEC, {}, always));
    expect(onCoffeeRun(state)).toBe(false); // exactly the gap: not yet
    ({ state } = stepFor(state, now, 1, {}, always));
    expect(onCoffeeRun(state)).toBe(true);
    expect(state.run!.standSec).toBe(COFFEE_RUN_STAND_MIN_SEC); // random 0: the shortest
  });

  it('no gap without a tool first: an idle stretch of work is not a gap between tools', () => {
    const { state } = stepFor(NO_COFFEE_RUN, 0, 60, {}, always);
    expect(onCoffeeRun(state)).toBe(false);
  });

  it(`one ${COFFEE_RUN_CHANCE * 100}% chance per gap`, () => {
    const draws: number[] = [];
    const random = () => {
      draws.push(0.5);
      return 0.5; // above the chance: no run
    };
    let { state, now } = toolThenGap(NO_COFFEE_RUN, 0, random);
    ({ state, now } = stepFor(state, now, 30, {}, random));
    expect(onCoffeeRun(state)).toBe(false);
    expect(draws).toHaveLength(1); // rolled once for the whole gap
    ({ state, now } = toolThenGap(state, now, random));
    stepFor(state, now, 30, {}, random);
    expect(draws).toHaveLength(2); // a new gap, a new chance
    expect(COFFEE_RUN_CHANCE).toBeGreaterThan(0.1);
    expect(COFFEE_RUN_CHANCE).toBeLessThan(0.2);
  });

  it('stands its time at the counter, then carries the cup back for 20 s', () => {
    let { state, now } = toolThenGap(NO_COFFEE_RUN, 0, always);
    ({ state, now } = stepFor(state, now, 5, {}, always));
    expect(onCoffeeRun(state)).toBe(true);
    // Walking there: time passes, but standing time only counts at the counter.
    ({ state, now } = stepFor(state, now, 20, {}, always));
    expect(onCoffeeRun(state)).toBe(true);
    ({ state, now } = stepFor(state, now, 1, { atCounterSec: 5 }, always));
    expect(onCoffeeRun(state)).toBe(true);
    ({ state, now } = stepFor(state, now, 0.5, { atCounterSec: 6 }, always));
    expect(onCoffeeRun(state)).toBe(false);
    expect(carryingCup(state, now)).toBe(true);
    expect(carryingCup(state, now + COFFEE_CUP_CARRY_SEC - 0.1)).toBe(true);
    ({ state, now } = stepFor(state, now, COFFEE_CUP_CARRY_SEC, {}, never));
    expect(carryingCup(state, now)).toBe(false);
    expect(state.cupUntil).toBeNull();
  });

  it(`at most once per ${COFFEE_RUN_COOLDOWN_SEC / 60} min`, () => {
    let { state, now } = toolThenGap(NO_COFFEE_RUN, 0, always);
    ({ state, now } = stepFor(state, now, 5, {}, always));
    const first = state.lastRunAt!;
    ({ state, now } = stepFor(state, now, 1, { atCounterSec: 10 }, always));
    expect(onCoffeeRun(state)).toBe(false);
    // Gap after gap, every chance taken: no run until the cooldown is up.
    while (now < first + COFFEE_RUN_COOLDOWN_SEC - 10) {
      ({ state, now } = toolThenGap(state, now, always));
      ({ state, now } = stepFor(state, now, 8, {}, always, 1));
      expect(onCoffeeRun(state)).toBe(false);
    }
    ({ state, now } = stepFor(state, now, 20, { liveTools: 1 }, always, 1));
    ({ state } = stepFor(state, now, 6, {}, always, 1));
    expect(onCoffeeRun(state)).toBe(true);
    expect(state.lastRunAt! - first).toBeGreaterThanOrEqual(COFFEE_RUN_COOLDOWN_SEC);
  });

  it('never while blocked (permission, question, test, sleep, smoke), nor with the counter full', () => {
    for (const input of [{ blocked: true }, { counterFree: false }]) {
      const gap = toolThenGap(NO_COFFEE_RUN, 0, always);
      const { state } = stepFor(gap.state, gap.now, 30, input, always);
      expect(onCoffeeRun(state)).toBe(false);
      expect(state.lastRunAt).toBeNull();
    }
  });

  it('called off, without a cup: when blocked, at a turn end, or when it cannot get there', () => {
    const start = () => {
      const s = toolThenGap(NO_COFFEE_RUN, 0, always);
      return stepFor(s.state, s.now, 5, {}, always);
    };
    for (const input of [{ blocked: true }, { active: false }]) {
      let { state, now } = start();
      expect(onCoffeeRun(state)).toBe(true);
      ({ state, now } = stepFor(state, now, 0.5, input, always));
      expect(onCoffeeRun(state)).toBe(false);
      expect(carryingCup(state, now)).toBe(false);
    }
    let { state, now } = start();
    ({ state, now } = stepFor(state, now, COFFEE_RUN_MAX_SEC + 1, {}, always));
    expect(onCoffeeRun(state)).toBe(false);
    expect(carryingCup(state, now)).toBe(false);
  });

  it('a coffee run is a destination after the blocking ones, before the desk', () => {
    const s = {
      sleeping: false,
      permission: false,
      askingUser: false,
      testing: false,
      longCommand: false,
      onBreak: false,
      active: true,
      waiting: false,
      coffeeRun: true,
    };
    expect(pickDestination(s)).toBe('coffee');
    expect(pickDestination({ ...s, coffeeRun: false })).toBe('desk');
    expect(pickDestination({ ...s, permission: true })).toBe('meeting');
    expect(pickDestination({ ...s, testing: true })).toBe('server');
    expect(pickDestination({ ...s, onBreak: true })).toBe('break');
    expect(pickDestination({ ...s, sleeping: true })).toBe('lounge');
    expect(pickDestination({ ...s, active: false, waiting: true })).toBe('smoke');
  });

  it('the seeded RNG repeats its sequence and stays in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 200 }, () => a());
    expect(Array.from({ length: 200 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(xs[0]);
  });

  it('the cup is 2×3 px at the hand, mirrored when facing left', () => {
    const right = cupPixels(Direction.RIGHT);
    const left = cupPixels(Direction.LEFT);
    expect(right).toHaveLength(6);
    expect(new Set(right.map((p) => p.dx)).size).toBe(2);
    expect(new Set(right.map((p) => p.dy)).size).toBe(3);
    expect(Math.min(...right.map((p) => p.dx))).toBeGreaterThan(0);
    expect(Math.max(...left.map((p) => p.dx))).toBeLessThan(0);
  });
});

// ── In the office ─────────────────────────────────────────────

const at = (ch: Character) => [ch.tileCol, ch.tileRow];
const seatTile = (os: OfficeState, uid: string) => {
  const seat = os.seats.get(uid)!;
  return [seat.seatCol, seat.seatRow];
};

/** An agent at its desk running one tool for `toolSec`, then between tools. */
function workerAt(os: OfficeState, id: number, seat: string, toolSec = 10): Character {
  os.addAgent(id, 0, 0, seat, true, 'repo');
  const ch = os.characters.get(id)!;
  os.noteToolStart(id, `t${id}`, 'Read', false);
  run(os, toolSec);
  os.noteToolDone(id, `t${id}`);
  return ch;
}

describe('coffee runs in the office', () => {
  it('to the counter in front of the coffee machine, a short stand, back to the desk with a cup', () => {
    const os = ambienceOffice();
    os.coffeeRandom = () => 0; // every chance taken, the shortest stand
    const ch = workerAt(os, 1, 'd1');
    run(os, COFFEE_RUN_GAP_SEC + 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
    expect([ch.zoneTarget!.col, ch.zoneTarget!.row]).toEqual([7, 4]); // below the machine
    expect(ch.zoneTarget!.sit).toBe(false);
    run(os, 3); // there
    expect(at(ch)).toEqual([7, 4]);
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(ch.dir).toBe(Direction.UP); // facing the machine
    expect(ch.carryingCup).toBeUndefined();
    run(os, COFFEE_RUN_STAND_MIN_SEC + 1);
    expect(ch.carryingCup).toBe(true);
    expect(ch.zoneTarget ?? null).toBeNull(); // heading back
    run(os, 8);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.carryingCup).toBe(true); // still sipping
    run(os, COFFEE_CUP_CARRY_SEC);
    expect(ch.carryingCup).toBeUndefined();
  });

  it('a permission request mid-run: straight to the Meeting room... or its desk without one', () => {
    const os = ambienceOffice();
    os.coffeeRandom = () => 0;
    const ch = workerAt(os, 1, 'd1');
    run(os, COFFEE_RUN_GAP_SEC + 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
    os.showPermissionBubble(1);
    run(os, 10);
    expect(ch.zoneTarget?.zone).not.toBe(ZoneLabel.CAFE); // this office has no Meeting room
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.carryingCup).toBeUndefined();
  });

  it('a test run mid-run calls it off, and it is not resumed after', () => {
    const os = ambienceOffice();
    os.coffeeRandom = () => 0;
    const ch = workerAt(os, 1, 'd1');
    run(os, COFFEE_RUN_GAP_SEC + 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
    os.setAgentProgress(1, 'test');
    os.noteToolStart(1, 'tests', 'Bash', false);
    run(os, 1);
    expect(ch.zoneTarget?.zone).not.toBe(ZoneLabel.CAFE);
    os.noteToolDone(1, 'tests');
    os.setAgentProgress(1, 'build');
    os.noteToolStart(1, 'edit', 'Edit', false); // straight on with work, no gap
    run(os, 20);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.carryingCup).toBeUndefined();
  });

  it('one at a time at the counter', () => {
    const os = ambienceOffice();
    os.coffeeRandom = () => 0;
    const a = workerAt(os, 1, 'd1', 2);
    const b = workerAt(os, 2, 'd2', 2);
    run(os, COFFEE_RUN_GAP_SEC + 1);
    const inCafe = [a, b].filter((ch) => ch.zoneTarget?.zone === ZoneLabel.CAFE);
    expect(inCafe).toHaveLength(1);
  });

  it('the default RNG is seeded: two offices make the same runs', () => {
    const trace = () => {
      const os = ambienceOffice();
      const ch = workerAt(os, 1, 'd1', 1);
      const seen: string[] = [];
      for (let gap = 0; gap < 20; gap++) {
        run(os, COFFEE_RUN_GAP_SEC + 2, 0.25);
        seen.push(ch.zoneTarget?.zone ?? '-');
        os.noteToolStart(1, `g${gap}`, 'Read', false);
        run(os, 1, 0.25);
        os.noteToolDone(1, `g${gap}`);
      }
      return seen.join(',');
    };
    expect(trace()).toBe(trace());
  });
});

// ── The receptionist ──────────────────────────────────────────

describe('the receptionist', () => {
  it('sits in the chair behind the Entrance reception desk, facing out', () => {
    const os = ambienceOffice();
    const r = os.receptionist!;
    expect(r).not.toBeNull();
    expect(r.isReceptionist).toBe(true);
    expect(at(r)).toEqual(seatTile(os, 'r1'));
    expect(r.state).toBe(CharacterState.TYPE);
    expect(r.dir).toBe(Direction.DOWN);
    expect(os.seats.get('r1')!.assigned).toBe(true);
  });

  it('is never an agent: not in characters, not seated over, persisted, picked or hit', () => {
    const os = ambienceOffice();
    for (let id = 1; id <= 5; id++) os.addAgent(id, 0, 0, undefined, true, 'repo');
    run(os, 1);
    expect(os.characters.has(RECEPTIONIST_ID)).toBe(false);
    expect([...os.characters.values()].map((c) => c.seatId)).not.toContain('r1');
    expect(Object.keys(os.getPersistableSeats())).not.toContain(String(RECEPTIONIST_ID));
    const r = os.receptionist!;
    expect(os.getCharacterAt(r.x, r.y)).toBeNull();
    // Drawn, though: getCharacters() is the render seam.
    expect(os.getCharacters()).toContain(r);
    expect(os.getCharacters().filter((c) => !c.isReceptionist)).toHaveLength(5);
  });

  it('stays at her post through a layout rebuild', () => {
    const os = ambienceOffice();
    const r = os.receptionist;
    os.addAgent(1, 0, 0, undefined, true, 'repo');
    os.rebuildFromLayout(os.getLayout());
    expect(os.receptionist).toBe(r);
    expect(os.seats.get('r1')!.assigned).toBe(true);
    expect(os.characters.get(1)!.seatId).not.toBe('r1');
  });

  it('none without a reception desk in the Entrance', () => {
    const os = ambienceOffice(AMBIENCE_FURNITURE.filter((f) => f.uid !== 'reception'));
    expect(os.receptionist).toBeNull();
    expect(os.getCharacters()).toHaveLength(0);
    // ...nor with one outside it (here, in the Café).
    const moved = AMBIENCE_FURNITURE.map((f) =>
      f.uid === 'reception'
        ? { ...f, col: 7, row: 5 }
        : f.uid === 'r1'
          ? { ...f, col: 8, row: 4 }
          : f,
    ).filter((f) => f.uid !== 'c1');
    expect(ambienceOffice(moved).receptionist).toBeNull();
  });

  it('waves for 1.5 s (two frames) when an agent walks in through the door', () => {
    const os = ambienceOffice();
    const r = os.receptionist!;
    run(os, 1);
    expect(r.waveFrame).toBeUndefined();
    os.addAgent(1, 0, 0, undefined, false, 'repo');
    os.enterThroughDoor(1);
    os.update(0.01);
    expect(r.waveFrame).toBe(0);
    run(os, RECEPTIONIST_WAVE_FRAME_SEC, 0.01);
    expect(r.waveFrame).toBe(1);
    run(os, RECEPTIONIST_WAVE_SEC, 0.05);
    expect(r.waveFrame).toBeUndefined();
    // A restored agent (no walk in) gets no wave.
    os.addAgent(2, 0, 0, undefined, true, 'repo');
    os.update(0.01);
    expect(r.waveFrame).toBeUndefined();
  });

  it('wave frames alternate, then stop', () => {
    expect(waveFrame(-0.1)).toBeNull();
    expect(waveFrame(0)).toBe(0);
    expect(waveFrame(RECEPTIONIST_WAVE_FRAME_SEC)).toBe(1);
    expect(waveFrame(2 * RECEPTIONIST_WAVE_FRAME_SEC)).toBe(0);
    expect(waveFrame(RECEPTIONIST_WAVE_SEC - 0.01)).not.toBeNull();
    expect(waveFrame(RECEPTIONIST_WAVE_SEC)).toBeNull();
  });

  it('the waving hand: up, then out; outlined, the outline never over the arm', () => {
    const up = waveHandPixels(0);
    const out = waveHandPixels(1);
    expect(up).not.toEqual(out);
    expect(Math.min(...out.map((p) => p.dx))).toBeLessThan(Math.min(...up.map((p) => p.dx)));
    // Clear of her head (the sprite's middle 12 px), beside it.
    expect(up.filter((p) => p.dy <= -15).every((p) => p.dx <= -9)).toBe(true);
    const arm = new Set(up.map((p) => `${p.dx},${p.dy}`));
    const ring = outlinePixels(up);
    expect(ring.length).toBeGreaterThan(0);
    expect(ring.some((p) => arm.has(`${p.dx},${p.dy}`))).toBe(false);
    expect(outlinePixels([{ dx: 0, dy: 0 }])).toHaveLength(4);
  });

  it('the night lights count agents only: her Entrance still dims when nobody is in it', () => {
    const os = ambienceOffice();
    const layout = os.getLayout();
    const empty = (characters: Character[]) =>
      [...emptyRoomTiles(layout.areaTiles, layout.cols, occupiedTiles(characters)).keys()].sort();
    expect(empty([os.receptionist!])).toEqual(['Cafe', 'Dev', 'Entrance']);
    os.addAgent(1, 0, 0, 'd1', true, 'repo');
    expect(empty(os.getCharacters())).toEqual(['Cafe', 'Entrance']);
    // An agent standing in the Entrance lights it.
    const r = os.receptionist!;
    expect(empty([...os.getCharacters(), { ...r, isReceptionist: false }])).toEqual(['Cafe']);
  });
});
