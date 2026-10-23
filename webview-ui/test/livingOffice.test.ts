/**
 * The living office in OfficeState (docs/office/DESIGN.md): characters walk
 * to the room that matches what their session is doing — Smoke when the turn
 * ended, the Lounge asleep, the Meeting room on a permission or a question,
 * the Server room while tests run — and back to their own desk when work
 * resumes. Destinations are held 8 s (except back to the desk or to a
 * meeting), crowded rooms overflow into the Cafe, new agents walk in through
 * the Entrance door and closed ones walk out of it. A layout without zones
 * behaves exactly as before.
 *
 * Like greeter / helperSeating, this pins the OfficeState domain model, which
 * e2e can't observe frame by frame.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ASHTRAY_BUTT_SLOTS,
  SMOKE_BREAK_AFTER_WORK_SEC,
  SMOKE_BREAK_COOLDOWN_SEC,
  SMOKE_BREAK_MIN_SEC,
  SMOKE_LONG_COMMAND_SEC,
  SMOKE_STUB_OUT_SEC,
  TRANSIENT_SESSION_SEC,
  ZONE_HOLD_MIN_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { ASHTRAY_BUTT_SPRITE, isSmoking } from '../src/office/engine/zoneEffects.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, Direction, MATRIX_EFFECT_DURATION } from '../src/office/types.js';
import { ZoneLabel } from '../src/office/zones.js';
import {
  chair,
  installZoneCatalog,
  layoutFrom,
  OFFICE_FURNITURE,
  OFFICE_MAP,
  RACK_ON_SPRITES,
  run,
  zonedOffice,
} from './livingOfficeFixture.js';

beforeAll(installZoneCatalog);

const at = (ch: Character) => [ch.tileCol, ch.tileRow];
const seatTile = (os: OfficeState, uid: string) => {
  const seat = os.seats.get(uid)!;
  return [seat.seatCol, seat.seatRow];
};

/** An agent restored at a desk (no spawn effect, no walk in). */
function agentAt(os: OfficeState, id: number, seat: string): Character {
  os.addAgent(id, 0, 0, seat, true);
  return os.characters.get(id)!;
}

/** An agent whose turn ended (agentStatus waiting) before the office ran. */
function waitingAt(os: OfficeState, id: number, seat: string): Character {
  const ch = agentAt(os, id, seat);
  os.setAgentActive(id, false);
  return ch;
}

describe('destinations', () => {
  it('turn ended: walks to the Smoke terrace, stands facing the ashtray, and smokes', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 15);
    // The spot nearest its desk: left of the ashtray, facing it.
    expect(at(ch)).toEqual([10, 2]);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(ch.dir).toBe(Direction.RIGHT);
    expect(isSmoking(ch)).toBe(true);
    // ...and stays: no wandering, however long the user takes.
    run(os, 120);
    expect(at(ch)).toEqual([10, 2]);
    expect(ch.zoneFxTimer).toBeGreaterThan(100);
  });

  it('work resumes: back to its own desk, typing', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 15);
    os.setAgentActive(1, true);
    // No hold for going back — just the cigarette to put out first.
    run(os, SMOKE_STUB_OUT_SEC + 0.1);
    expect(ch.zoneTarget ?? null).toBeNull();
    run(os, 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(isSmoking(ch)).toBe(false);
  });

  it('asleep with no status ever received: still goes to the Lounge', () => {
    // A long-idle session adopted from the session list never sends an
    // agentStatus: its character keeps the default isActive=true. The
    // server's agentSleep alone must be enough.
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    os.setAgentSleeping(1, true);
    run(os, 15);
    expect(ch.isActive).toBe(false);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.LOUNGE);
    expect(at(ch)).toEqual(seatTile(os, ch.zoneTarget!.key));
  });

  it('asleep: a Lounge seat, sitting still, reserved while it is there', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 15); // smoking since the start: well past the hold
    os.setAgentSleeping(1, true);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.LOUNGE);
    expect(at(ch)).toEqual(seatTile(os, ch.zoneTarget!.key));
    expect(ch.state).toBe(CharacterState.TYPE);
    const frame = ch.frame;
    run(os, 60);
    expect(ch.frame).toBe(frame);
    expect(os.seats.get(ch.zoneTarget!.key)!.assigned).toBe(true);
    // Its desk stays its own all along.
    expect(ch.seatId).toBe('d1');
    expect(os.seats.get('d1')!.assigned).toBe(true);
  });

  it('a permission request: straight to the Meeting room, even mid-hold, and back on the answer', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 2); // on its way to smoke, nowhere near the 8 s hold
    os.setAgentActive(1, true);
    os.showPermissionBubble(1);
    run(os, 0.1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    run(os, 15);
    expect(at(ch)).toEqual(seatTile(os, 'm0')); // the chair nearest the way in
    expect(ch.state).toBe(CharacterState.TYPE);
    // Clicking the bubble away doesn't answer the request.
    os.dismissBubble(1);
    run(os, 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    // The answer (permission cleared) sends it back to work at once.
    os.clearPermissionBubble(1);
    run(os, 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(os.seats.get('m0')!.assigned).toBe(false);
  });

  it('a live AskUserQuestion is a meeting too, until it is done', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    os.noteToolStart(1, 'q', 'AskUserQuestion', false);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    os.noteToolDone(1, 'q');
    run(os, 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
  });

  it('a test run: the Server room, facing the racks, which blink while it is there', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    const racksOn = () => os.furniture.filter((f) => RACK_ON_SPRITES.includes(f.sprite)).length;
    run(os, ZONE_HOLD_MIN_SEC + 1); // at its desk past the hold
    expect(racksOn()).toBe(0);
    os.setAgentProgress(1, 'test');
    os.noteToolStart(1, 'b', 'Bash', false);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SERVER);
    expect(at(ch)).toEqual([15, 3]);
    expect(ch.dir).toBe(Direction.UP);
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(racksOn()).toBe(2);
    // The command finishes: back to the desk, and the racks go dark.
    os.noteToolDone(1, 'b');
    run(os, 1);
    expect(racksOn()).toBe(0);
  });

  it('a shell command outside the test phase is plain desk work', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    run(os, ZONE_HOLD_MIN_SEC + 1);
    os.setAgentProgress(1, 'build');
    os.noteToolStart(1, 'b', 'Bash', false);
    run(os, 10);
    expect(ch.zoneTarget ?? null).toBeNull();
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
  });

  it('agentToolsClear ends every live tool', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    os.noteToolStart(1, 'q', 'AskUserQuestion', false);
    run(os, 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    os.clearAgentTools(1);
    run(os, 0.1);
    expect(ch.zoneTarget ?? null).toBeNull();
  });
});

describe('hysteresis', () => {
  it(`a turn that ends right after it began keeps the desk ${ZONE_HOLD_MIN_SEC} s, seated`, () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    run(os, 2); // working at the desk (the desk was chosen at t=0)
    os.setAgentActive(1, false);
    run(os, ZONE_HOLD_MIN_SEC - 2 - 0.5);
    // Still held at its desk — sitting, not wandering off.
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.zoneTarget?.zone).toBeNull();
    run(os, 1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
  });

  it('a short burst of work between smokes sends it to the desk and back after the hold', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 15);
    os.setAgentActive(1, true); // back to the desk, immediately
    run(os, 1);
    os.setAgentActive(1, false); // done again a second later
    run(os, 3);
    expect(ch.zoneTarget?.zone ?? null).not.toBe(ZoneLabel.SMOKE); // held at the desk
    run(os, ZONE_HOLD_MIN_SEC);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
  });
});

describe('places are shared fairly', () => {
  it('two smokers take two different spots', () => {
    const os = zonedOffice();
    const a = waitingAt(os, 1, 'd1');
    const b = waitingAt(os, 2, 'd2');
    run(os, 15);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(b.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(at(a)).not.toEqual(at(b));
  });

  it("never takes a seat that is someone's desk", () => {
    const os = zonedOffice();
    const worker = agentAt(os, 1, 'l1'); // the office was full: its desk is a sofa
    const sleeper = waitingAt(os, 2, 'd1');
    os.setAgentSleeping(2, true);
    run(os, 15);
    expect(sleeper.zoneTarget?.key).toBe('l2');
    expect(at(worker)).toEqual(seatTile(os, 'l1'));
  });

  it('a seat a sleeper holds is not handed out as a desk', () => {
    const os = zonedOffice();
    const sleeper = waitingAt(os, 1, 'd1');
    os.setAgentSleeping(1, true);
    run(os, 15);
    const sofa = sleeper.zoneTarget!.key;
    for (let id = 2; id <= 9; id++) os.addAgent(id, 0, 0, undefined, true);
    const desks = [...os.characters.values()].map((c) => c.seatId);
    expect(desks).not.toContain(sofa);
  });
});

describe('crowding', () => {
  // Desks d1..d4 above a strip of tiny rooms: a one-spot Smoke terrace (the
  // ashtray at (1,3)), one Lounge sofa, one Cafe bench, one Meeting chair.
  const CROWD_MAP = ['WWWWWWWWWW', 'WDDDDDDDDW', 'WDDDDDDDDW', 'WKKLLCCMMW', 'WWWWWWWWWW'];
  const crowdOffice = () =>
    new OfficeState(
      layoutFrom(CROWD_MAP, [
        chair('d1', 2, 1),
        chair('d2', 4, 1),
        chair('d3', 6, 1),
        chair('d4', 8, 1),
        { uid: 'ashtray', type: 'ASHTRAY_STAND', col: 1, row: 3 },
        chair('l1', 3, 3),
        chair('c1', 5, 3),
        chair('m1', 8, 3),
      ]),
    );

  it('Smoke full: the Cafe; nothing free: stays at its desk, then smokes once a spot frees', () => {
    const os = crowdOffice();
    const a = waitingAt(os, 1, 'd1');
    const b = waitingAt(os, 2, 'd2');
    const c = waitingAt(os, 3, 'd3');
    run(os, 15);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(b.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
    expect(at(b)).toEqual(seatTile(os, 'c1'));
    // No free place anywhere: it waits at its own desk, seated, not wandering.
    expect(c.zoneTarget?.zone).toBeNull();
    run(os, 60);
    expect(at(c)).toEqual(seatTile(os, 'd3'));
    expect(c.state).toBe(CharacterState.TYPE);
    // The smoker goes back to work: the spot frees and the one waiting takes it.
    os.setAgentActive(1, true);
    run(os, 15);
    expect(c.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(at(c)).toEqual([2, 3]);
  });

  it('Lounge full: the Cafe', () => {
    const os = crowdOffice();
    const a = waitingAt(os, 1, 'd1');
    const b = waitingAt(os, 2, 'd2');
    os.setAgentSleeping(1, true);
    os.setAgentSleeping(2, true);
    run(os, 15);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.LOUNGE);
    expect(b.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
  });

  it('Meeting full: the second one asks from its desk', () => {
    const os = crowdOffice();
    const a = agentAt(os, 1, 'd1');
    const b = agentAt(os, 2, 'd2');
    os.showPermissionBubble(1);
    os.showPermissionBubble(2);
    run(os, 15);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    expect(b.zoneTarget ?? null).toBeNull();
    expect(at(b)).toEqual(seatTile(os, 'd2'));
    expect(b.state).toBe(CharacterState.TYPE);
  });
});

describe('desks in a zoned office', () => {
  it('fills the desks first, then the Cafe and Lounge, and only then a meeting chair', () => {
    const os = zonedOffice();
    const zoneOf = (id: number) => os.seatZone(os.characters.get(id)!.seatId!);
    for (let id = 1; id <= 8; id++) os.addAgent(id, 0, 0, undefined, true);
    expect([1, 2, 3].map(zoneOf)).toEqual(['Dev', 'Dev', 'Dev']);
    for (const id of [4, 5, 6, 7]) expect(['Cafe', 'Lounge']).toContain(zoneOf(id));
    expect(zoneOf(8)).toBe('Meeting');
  });

  it('a helper takes the nearest free desk, not a nearer room seat', () => {
    const helperSeatIn = (os: OfficeState) => {
      os.addAgent(1, 0, 0, 'd3', true);
      os.addAgent(2, 0, 0, 'd2', true);
      return os.characters.get(os.addSubagent(1, 'task'))!.seatId;
    };
    // d1 is 4 tiles from the parent's desk, the meeting chair m0 only 3.
    expect(helperSeatIn(zonedOffice())).toBe('d1');
    // Without zones the nearest seat wins, as it always has.
    const plain = new OfficeState(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE, { withAreas: false }));
    expect(helperSeatIn(plain)).toBe('m0');
  });

  it('helpers are not routed: they stay at their desk while the parent smokes', () => {
    const os = zonedOffice();
    os.addAgent(1, 0, 0, 'd1', true);
    const helper = os.characters.get(os.addSubagent(1, 'task'))!;
    os.setAgentActive(1, false);
    run(os, 15);
    expect(os.characters.get(1)!.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(helper.zoneTarget ?? null).toBeNull();
    expect(at(helper)).toEqual(seatTile(os, helper.seatId!));
  });
});

describe('the Entrance', () => {
  it('a new agent materializes at the door and walks to its desk', () => {
    const os = zonedOffice();
    os.addAgent(1, 0, 0, 'd1', false);
    os.enterThroughDoor(1);
    const ch = os.characters.get(1)!;
    expect(at(ch)).toEqual([19, 7]);
    expect(ch.matrixEffect).toBe('spawn'); // the effect plays at the door
    expect(ch.dir).toBe(Direction.LEFT);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.at(-1)).toEqual({ col: 2, row: 2 });
    run(os, MATRIX_EFFECT_DURATION + 12);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
  });

  it('a closed agent walks out to the door, then despawns there; its desk frees at once', () => {
    const os = zonedOffice();
    os.addAgent(1, 0, 0, 'd1', true);
    os.enterThroughDoor(1);
    run(os, TRANSIENT_SESSION_SEC + 1);
    os.removeAgent(1);
    const ch = os.characters.get(1)!;
    expect(ch.leaving).toBe(true);
    expect(ch.matrixEffect).toBeNull();
    expect(ch.path.at(-1)).toEqual({ col: 19, row: 7 });
    expect(os.seats.get('d1')!.assigned).toBe(false);
    expect(os.getCharacterAt(ch.x, ch.y)).toBeNull(); // not clickable on its way out
    expect(os.getPersistableSeats()[1]).toBeUndefined();
    let despawnedAt: number[] | null = null;
    for (let t = 0; t < 15 && os.characters.has(1); t += 0.05) {
      os.update(0.05);
      if (!despawnedAt && ch.matrixEffect === 'despawn') despawnedAt = at(ch);
    }
    expect(despawnedAt).toEqual([19, 7]);
    expect(os.characters.has(1)).toBe(false);
  });

  it(`a session shorter than ${TRANSIENT_SESSION_SEC} s skips the walk out`, () => {
    const os = zonedOffice();
    os.addAgent(1, 0, 0, 'd1', true);
    os.enterThroughDoor(1);
    run(os, 5);
    os.removeAgent(1);
    const ch = os.characters.get(1)!;
    expect(ch.leaving).toBeFalsy();
    expect(ch.matrixEffect).toBe('despawn');
    run(os, MATRIX_EFFECT_DURATION + 0.1);
    expect(os.characters.has(1)).toBe(false);
  });

  it('a restored agent (no walk in, session length unknown) walks out', () => {
    const os = zonedOffice();
    agentAt(os, 1, 'd1');
    os.removeAgent(1);
    expect(os.characters.get(1)!.leaving).toBe(true);
  });

  it('an agent back before its old character is out takes over', () => {
    const os = zonedOffice();
    agentAt(os, 1, 'd1');
    os.removeAgent(1);
    os.addAgent(1, 0, 0, 'd2', true);
    const ch = os.characters.get(1)!;
    expect(ch.leaving).toBeFalsy();
    expect(ch.seatId).toBe('d2');
  });

  it('a layout rebuild mid walk-out finishes leaving on the spot', () => {
    const os = zonedOffice();
    agentAt(os, 1, 'd1');
    os.removeAgent(1);
    os.rebuildFromLayout(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE));
    expect(os.characters.get(1)!.matrixEffect).toBe('despawn');
    expect(os.characters.get(1)!.seatId).toBeNull(); // not handed a seat by the rebuild
  });
});

describe('a layout without zones behaves as before', () => {
  const plainOffice = () =>
    new OfficeState(layoutFrom(OFFICE_MAP, OFFICE_FURNITURE, { withAreas: false }));

  it('a waiting agent stands up and wanders; no zone target, ever', () => {
    const os = plainOffice();
    const ch = waitingAt(os, 1, 'd1');
    let left = false;
    for (let t = 0; t < 120; t += 0.05) {
      os.update(0.05);
      expect(ch.zoneTarget ?? null).toBeNull();
      if (at(ch).join() !== seatTile(os, 'd1').join()) left = true;
    }
    expect(left).toBe(true);
  });

  it('no walk in, no walk out: spawn and despawn at the desk', () => {
    const os = plainOffice();
    os.addAgent(1, 0, 0, 'd1', false);
    os.enterThroughDoor(1);
    const ch = os.characters.get(1)!;
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.path).toEqual([]);
    run(os, 30);
    os.removeAgent(1);
    expect(ch.leaving).toBeFalsy();
    expect(ch.matrixEffect).toBe('despawn');
  });

  it('signals that route in a zoned office change nothing: same moves, frame for frame', () => {
    // Same scenario, seeded randomness, in two zone-less layouts: one with no
    // Areas, one with only a user's own Area. Then the same again with every
    // living-office signal fired: nothing may differ.
    const scenario = (withSignals: boolean, map: string[], withAreas: boolean) => {
      let seed = 7;
      const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      });
      try {
        const os = new OfficeState(layoutFrom(map, OFFICE_FURNITURE, { withAreas }));
        os.addAgent(1, 0, 0, 'd1', true);
        os.addAgent(2, 1, 0, 'd2', true);
        os.addAgent(3, 2, 0, undefined, false);
        os.enterThroughDoor(3);
        os.setAgentActive(1, false);
        if (withSignals) {
          os.noteToolStart(2, 'b', 'Bash', false);
          os.setAgentProgress(2, 'test');
          os.showPermissionBubble(3);
          os.noteToolStart(3, 'q', 'AskUserQuestion', true);
        }
        const trace: string[] = [];
        for (let t = 0; t < 90; t += 0.05) {
          os.update(0.05);
          if (Math.round(t * 20) % 20 === 0) {
            trace.push(
              [...os.characters.values()]
                .map((c) => `${c.id}:${c.tileCol},${c.tileRow},${c.state},${c.dir}`)
                .join(' '),
            );
          }
          if (Math.abs(t - 40) < 0.01) {
            os.setAgentSleeping(1, true);
            os.removeAgent(2);
          }
        }
        return trace;
      } finally {
        spy.mockRestore();
      }
    };
    const userAreas = OFFICE_MAP.map((line) => line.replace(/[DKSLMCE]/g, 'X'));
    const baseline = scenario(false, OFFICE_MAP, false);
    expect(scenario(false, userAreas, true)).toEqual(baseline);
    expect(scenario(true, OFFICE_MAP, false)).toEqual(baseline);
    expect(scenario(true, userAreas, true)).toEqual(baseline);
  });
});

describe('a smoke break', () => {
  const butts = (os: OfficeState) =>
    os.furniture.filter((f) => f.sprite === ASHTRAY_BUTT_SPRITE).length;

  it('called back to work, it stubs out at the ashtray first, then goes to its desk', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    run(os, 15); // well into its cigarette
    os.setAgentActive(1, true);
    run(os, SMOKE_STUB_OUT_SEC / 2);
    expect(ch.smokeStubAt).toBeDefined();
    expect(at(ch)).toEqual([10, 2]); // still at the ashtray...
    expect(ch.dir).toBe(Direction.RIGHT); // ...facing it
    run(os, SMOKE_STUB_OUT_SEC);
    expect(ch.zoneTarget ?? null).toBeNull();
    expect(ch.smokeStubAt).toBeUndefined();
    run(os, 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
  });

  it('called away before it has lit up, it just goes', () => {
    const os = zonedOffice();
    const ch = waitingAt(os, 1, 'd1');
    for (let t = 0; t < 15 && !isSmoking(ch); t += 0.05) os.update(0.05);
    expect(isSmoking(ch)).toBe(true);
    os.setAgentActive(1, true);
    run(os, 0.1);
    expect(ch.zoneTarget ?? null).toBeNull();
  });

  it('smokers in company face each other, not the ashtray', () => {
    const os = zonedOffice();
    const a = waitingAt(os, 1, 'd1');
    const b = waitingAt(os, 2, 'd2');
    run(os, 15);
    expect([at(a), at(b)]).toEqual([
      [10, 2],
      [10, 3],
    ]);
    expect(a.dir).toBe(Direction.DOWN);
    expect(b.dir).toBe(Direction.UP);
    // One goes back to work: the other turns back to the ashtray.
    os.setAgentActive(1, true);
    run(os, SMOKE_STUB_OUT_SEC + 1);
    expect(b.dir).toBe(Direction.RIGHT);
  });

  it('the ashtray fills with butts as the wait goes on, and empties when nobody waits', () => {
    const os = zonedOffice();
    const now = 1_000_000_000_000;
    os.nowMs = () => now;
    waitingAt(os, 1, 'd1');
    os.setAgentProgress(1, 'build', now - 11 * 60_000); // waiting for 11 min
    run(os, 15);
    expect(butts(os)).toBe(2); // one per 5 min
    os.setAgentProgress(1, 'build', now - 3 * 3600_000);
    run(os, 1);
    expect(butts(os)).toBe(ASHTRAY_BUTT_SLOTS.length); // capped
    os.setAgentActive(1, true); // nobody waits any more
    run(os, SMOKE_STUB_OUT_SEC + 1);
    expect(butts(os)).toBe(0);
  });

  it('only a character standing at a Smoke spot smokes — not one in the Cafe overflow', () => {
    const os = new OfficeState(
      layoutFrom(
        ['WWWWWW', 'WDDDDW', 'WKKCCW', 'WWWWWW'],
        [
          chair('d1', 1, 1),
          chair('d2', 3, 1),
          { uid: 'ashtray', type: 'ASHTRAY_STAND', col: 1, row: 2 },
          chair('c1', 4, 2),
        ],
      ),
    );
    const a = waitingAt(os, 1, 'd1');
    const b = waitingAt(os, 2, 'd2');
    run(os, 10);
    expect(isSmoking(a)).toBe(true);
    expect(b.zoneTarget?.zone).toBe(ZoneLabel.CAFE);
    expect(isSmoking(b)).toBe(false);
  });
});

describe('mid-work smokes', () => {
  const butts = (os: OfficeState) =>
    os.furniture.filter((f) => f.sprite === ASHTRAY_BUTT_SPRITE).length;

  it('(A) a long shell command that is not a test: out for a smoke while it runs, tagged', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    os.setAgentProgress(1, 'build');
    os.noteToolStart(1, 'install', 'Bash', false);
    run(os, SMOKE_LONG_COMMAND_SEC - 1);
    expect(ch.zoneTarget ?? null).toBeNull(); // not long yet
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(isSmoking(ch)).toBe(true);
    expect(ch.smokeBreak).toBe('command');
    expect(butts(os)).toBe(0); // the ashtray only counts waits on the user
    // The command finishes: it stubs out and is back at work.
    os.noteToolDone(1, 'install');
    run(os, SMOKE_STUB_OUT_SEC + 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.smokeBreak).toBeUndefined();
  });

  it('(A) a long test or build run is the Server room, not a smoke', () => {
    const os = zonedOffice();
    const ch = agentAt(os, 1, 'd1');
    run(os, ZONE_HOLD_MIN_SEC + 1);
    os.setAgentProgress(1, 'test');
    os.noteToolStart(1, 'tests', 'Bash', false);
    run(os, SMOKE_LONG_COMMAND_SEC + 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SERVER);
    expect(ch.smokeBreak).toBeUndefined();
  });

  it('(B) after long work, a break at a gap; back at the desk after it while still working; once an hour', () => {
    const os = zonedOffice();
    os.zoneRandom = () => 0; // every chance taken, the shortest break
    const ch = agentAt(os, 1, 'd1');
    run(os, SMOKE_BREAK_AFTER_WORK_SEC - 5, 0.5);
    expect(ch.zoneTarget ?? null).toBeNull();
    run(os, 20); // 40 min in, no tool live: a natural gap
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
    expect(ch.smokeBreak).toBe('break');
    expect(ch.isActive).toBe(true);
    // 60 s later (the shortest break) it's back at its desk, still working.
    run(os, SMOKE_BREAK_MIN_SEC + SMOKE_STUB_OUT_SEC + 15);
    expect(at(ch)).toEqual(seatTile(os, 'd1'));
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.smokeBreak).toBeUndefined();
    // No second break within the hour, gaps or not.
    for (let t = 0; t < SMOKE_BREAK_COOLDOWN_SEC - SMOKE_BREAK_MIN_SEC - 120; t += 0.5) {
      os.update(0.5);
      expect(ch.zoneTarget ?? null).toBeNull();
    }
  });

  it('(B) not with the Smoke terrace full — no Cafe overflow for a break', () => {
    // One Smoke spot, taken by someone waiting on the user.
    const os = new OfficeState(
      layoutFrom(
        ['WWWWWW', 'WDDDDW', 'WKKCCW', 'WWWWWW'],
        [
          chair('d1', 1, 1),
          chair('d2', 3, 1),
          { uid: 'ashtray', type: 'ASHTRAY_STAND', col: 1, row: 2 },
          chair('c1', 4, 2),
        ],
      ),
    );
    os.zoneRandom = () => 0;
    waitingAt(os, 1, 'd1');
    const worker = agentAt(os, 2, 'd2');
    run(os, SMOKE_BREAK_AFTER_WORK_SEC + 60, 0.5);
    expect(worker.zoneTarget ?? null).toBeNull();
    expect(at(worker)).toEqual(seatTile(os, 'd2'));
  });

  it('(B) never during a permission request', () => {
    const os = zonedOffice();
    os.zoneRandom = () => 0;
    const ch = agentAt(os, 1, 'd1');
    os.showPermissionBubble(1);
    run(os, SMOKE_BREAK_AFTER_WORK_SEC + 60, 0.5);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    expect(ch.smokeBreak).toBeUndefined();
  });
});
