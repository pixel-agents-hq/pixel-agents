/**
 * The living office's destination rules (zoneRouting.ts), pure: which room
 * the signals pick (first match wins), how long a destination is kept before
 * a switch (hysteresis, on an injected clock), and which free place in which
 * room a character takes (crowding overflow).
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { SMOKE_LONG_COMMAND_SEC, ZONE_HOLD_MIN_SEC } from '../src/constants.js';
import type { DestinationSignals } from '../src/office/engine/zoneRouting.js';
import {
  choosePlace,
  Destination,
  holdDestination,
  liveToolSignals,
  pickDestination,
} from '../src/office/engine/zoneRouting.js';
import type { OfficeZones, ZonePlace } from '../src/office/zones.js';
import { ZoneLabel } from '../src/office/zones.js';
import { installZoneCatalog, zonedOffice } from './livingOfficeFixture.js';

beforeAll(installZoneCatalog);

const NONE: DestinationSignals = {
  sleeping: false,
  permission: false,
  askingUser: false,
  testing: false,
  longCommand: false,
  onBreak: false,
  active: false,
  waiting: false,
};
const tool = (name: string | null, startedAt = 0) => ({ name, startedAt });
const signals = (over: Partial<DestinationSignals>): DestinationSignals => ({ ...NONE, ...over });

describe('the rules, first match wins', () => {
  it('each signal alone picks its room', () => {
    expect(pickDestination(signals({ sleeping: true }))).toBe(Destination.LOUNGE);
    expect(pickDestination(signals({ permission: true }))).toBe(Destination.MEETING);
    expect(pickDestination(signals({ askingUser: true }))).toBe(Destination.MEETING);
    expect(pickDestination(signals({ testing: true }))).toBe(Destination.SERVER);
    expect(pickDestination(signals({ active: true }))).toBe(Destination.DESK);
    expect(pickDestination(signals({ waiting: true }))).toBe(Destination.SMOKE);
    expect(pickDestination(NONE)).toBe(Destination.IDLE);
  });

  it('sleeping > meeting > server > desk > smoke', () => {
    const all = signals({
      sleeping: true,
      permission: true,
      askingUser: true,
      testing: true,
      active: true,
      waiting: true,
    });
    expect(pickDestination(all)).toBe(Destination.LOUNGE);
    expect(pickDestination({ ...all, sleeping: false })).toBe(Destination.MEETING);
    expect(pickDestination({ ...all, sleeping: false, permission: false, askingUser: false })).toBe(
      Destination.SERVER,
    );
    expect(pickDestination(signals({ active: true, waiting: true }))).toBe(Destination.DESK);
  });

  it('a permission or a question while a test runs is a meeting, not the server room', () => {
    expect(pickDestination(signals({ active: true, testing: true, permission: true }))).toBe(
      Destination.MEETING,
    );
  });

  it('mid-work smokes (a long command, a break) only while working, after the server room', () => {
    expect(pickDestination(signals({ active: true, longCommand: true }))).toBe(Destination.BREAK);
    expect(pickDestination(signals({ active: true, onBreak: true }))).toBe(Destination.BREAK);
    expect(pickDestination(signals({ active: true, onBreak: true, testing: true }))).toBe(
      Destination.SERVER,
    );
    expect(pickDestination(signals({ active: true, onBreak: true, permission: true }))).toBe(
      Destination.MEETING,
    );
    // The turn ended mid-break: an ordinary wait on the user.
    expect(pickDestination(signals({ waiting: true, onBreak: true }))).toBe(Destination.SMOKE);
  });
});

describe('live tools as signals', () => {
  it('a live AskUserQuestion is a question to the user', () => {
    expect(liveToolSignals([tool('Read'), tool('AskUserQuestion')], 'build', 1)).toEqual({
      askingUser: true,
      testing: false,
      longCommand: false,
    });
  });

  it('a live shell tool counts as testing only in phase test', () => {
    expect(liveToolSignals([tool('Bash')], 'test', 1).testing).toBe(true);
    expect(liveToolSignals([tool('PowerShell')], 'test', 1).testing).toBe(true);
    expect(liveToolSignals([tool('Bash')], 'build', 1).testing).toBe(false);
    expect(liveToolSignals([tool('Bash')], undefined, 1).testing).toBe(false);
    expect(liveToolSignals([tool('Edit'), tool(null)], 'test', 1).testing).toBe(false);
  });

  it(`a shell command running over ${SMOKE_LONG_COMMAND_SEC} s is a long command — unless it is a test/build`, () => {
    const started = 100;
    const at = (s: number, phase?: string) =>
      liveToolSignals([tool('Bash', started)], phase, started + s).longCommand;
    expect(at(SMOKE_LONG_COMMAND_SEC - 1, 'build')).toBe(false);
    expect(at(SMOKE_LONG_COMMAND_SEC + 1, 'build')).toBe(true);
    expect(at(SMOKE_LONG_COMMAND_SEC + 1, undefined)).toBe(true);
    expect(at(SMOKE_LONG_COMMAND_SEC + 1, 'test')).toBe(false); // the Server room's
    expect(liveToolSignals([tool('Read', 0)], 'build', 999).longCommand).toBe(false);
  });
});

describe('hysteresis (injected clock)', () => {
  it('the first destination is taken at once', () => {
    expect(holdDestination(undefined, Destination.SMOKE, 42)).toEqual({
      kind: Destination.SMOKE,
      since: 42,
    });
  });

  it('keeps the same destination object while nothing changes', () => {
    const at = { kind: Destination.SMOKE, since: 0 };
    expect(holdDestination(at, Destination.SMOKE, 100)).toBe(at);
  });

  it(`keeps a destination ${ZONE_HOLD_MIN_SEC} s before switching away from it`, () => {
    const desk = { kind: Destination.DESK, since: 10 };
    expect(holdDestination(desk, Destination.SMOKE, 10 + ZONE_HOLD_MIN_SEC - 0.1)).toBe(desk);
    expect(holdDestination(desk, Destination.SMOKE, 10 + ZONE_HOLD_MIN_SEC)).toEqual({
      kind: Destination.SMOKE,
      since: 10 + ZONE_HOLD_MIN_SEC,
    });
    const smoke = { kind: Destination.SMOKE, since: 0 };
    expect(holdDestination(smoke, Destination.SERVER, 3)).toBe(smoke);
    expect(holdDestination(smoke, Destination.LOUNGE, 3)).toBe(smoke);
  });

  it('going back to the desk, or to a meeting, is immediate', () => {
    const smoke = { kind: Destination.SMOKE, since: 0 };
    expect(holdDestination(smoke, Destination.DESK, 0.5).kind).toBe(Destination.DESK);
    expect(holdDestination(smoke, Destination.MEETING, 0.5).kind).toBe(Destination.MEETING);
    const server = { kind: Destination.SERVER, since: 0 };
    expect(holdDestination(server, Destination.DESK, 0.1).kind).toBe(Destination.DESK);
  });

  it('leaving a meeting is held like any other destination', () => {
    const meeting = { kind: Destination.MEETING, since: 0 };
    expect(holdDestination(meeting, Destination.SMOKE, 2)).toBe(meeting);
  });

  it('the hold can be tuned', () => {
    const desk = { kind: Destination.DESK, since: 0 };
    expect(holdDestination(desk, Destination.SMOKE, 1, 1).kind).toBe(Destination.SMOKE);
  });
});

describe('crowding: which place', () => {
  let zones: OfficeZones;
  beforeAll(() => {
    zones = zonedOffice().zones;
  });
  const free = () => false;
  const taken = (keys: string[]) => (p: ZonePlace) => keys.includes(p.key);
  const smokeKeys = () => zones.zones.get(ZoneLabel.SMOKE)!.places.map((p) => p.key);

  it('desk and idle are not rooms', () => {
    expect(choosePlace(zones, Destination.DESK, { col: 1, row: 1 }, free)).toEqual({
      kind: 'absent',
    });
    expect(choosePlace(zones, Destination.IDLE, { col: 1, row: 1 }, free).kind).toBe('absent');
  });

  it('the free place nearest the character', () => {
    const choice = choosePlace(zones, Destination.SMOKE, { col: 9, row: 3 }, free);
    expect(choice.kind).toBe('place');
    if (choice.kind !== 'place') return;
    expect([choice.place.col, choice.place.row]).toEqual([10, 3]);
    expect(choice.place.zone).toBe(ZoneLabel.SMOKE);
  });

  it('Smoke full: the Cafe', () => {
    const choice = choosePlace(zones, Destination.SMOKE, { col: 2, row: 2 }, taken(smokeKeys()));
    expect(choice.kind === 'place' && choice.place.zone).toBe(ZoneLabel.CAFE);
    expect(choice.kind === 'place' && choice.place.sit).toBe(true);
  });

  it('Lounge full: the Cafe', () => {
    const choice = choosePlace(zones, Destination.LOUNGE, { col: 2, row: 2 }, taken(['l1', 'l2']));
    expect(choice.kind === 'place' && choice.place.zone).toBe(ZoneLabel.CAFE);
  });

  it('a mid-work break takes a Smoke spot, but never overflows to the Cafe', () => {
    const choice = choosePlace(zones, Destination.BREAK, { col: 9, row: 3 }, free);
    expect(choice.kind === 'place' && choice.place.zone).toBe(ZoneLabel.SMOKE);
    expect(choosePlace(zones, Destination.BREAK, { col: 2, row: 2 }, taken(smokeKeys()))).toEqual({
      kind: 'full',
    });
  });

  it('no free place anywhere: full (stay at the desk)', () => {
    const all = [...smokeKeys(), 'c1', 'c2'];
    expect(choosePlace(zones, Destination.SMOKE, { col: 2, row: 2 }, taken(all))).toEqual({
      kind: 'full',
    });
    expect(
      choosePlace(zones, Destination.MEETING, { col: 2, row: 2 }, taken(['m0', 'm1', 'm2'])),
    ).toEqual({ kind: 'full' });
  });

  it('a room the layout lacks is skipped, overflow or not', () => {
    const noSmoke: OfficeZones = { ...zones, zones: new Map(zones.zones) };
    noSmoke.zones.delete(ZoneLabel.SMOKE);
    expect(choosePlace(noSmoke, Destination.SMOKE, { col: 2, row: 2 }, free)).toEqual({
      kind: 'absent',
    });
  });
});
