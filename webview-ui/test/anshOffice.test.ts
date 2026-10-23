/**
 * Phase M in the office (docs/office/DESIGN.md): permission requests knock on
 * the `Ansh` room's door (questions still go to Meeting; without the room,
 * permissions go to Meeting as before), and the two NPCs — Ansh at the desk
 * in the room, the Manager at the desk outside — are never agents: not in
 * `characters`, never given to an agent as a seat, not selectable. On a report
 * the Manager walks into the room, stands by Ansh's desk, and walks back.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { AnshThoughtEntry } from '../../core/src/messages.js';
import {
  ANSH_CHAT_STAY_SEC,
  ANSH_NPC_ID,
  ANSH_STRETCH_RADIUS_TILES,
  ANSH_VISIT_STAY_SEC,
  ANSH_WANDER_MIN_SEC,
  ANSH_WANDER_STAY_SEC,
  KNOCK_BOB_PX,
  KNOCK_INTERVAL_SEC,
  MANAGER_NPC_ID,
  MANAGER_VISIT_STAY_SEC,
} from '../src/constants.js';
import { findNpcPlaces, knockSpots } from '../src/office/anshOffice.js';
import { knockBobPx } from '../src/office/engine/npcs.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { Destination, pickDestination } from '../src/office/engine/zoneRouting.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { Character, OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';
import { ZoneLabel } from '../src/office/zones.js';
import { chair, run } from './livingOfficeFixture.js';

/** Chairs and a 3×2 desk with a walkable back row (a chair beside it faces it). */
beforeAll(() => {
  const ok = buildDynamicCatalog({
    catalog: [
      {
        id: 'CHAIR',
        label: 'CHAIR',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
      {
        id: 'DESK',
        label: 'DESK',
        category: 'desks',
        width: 48,
        height: 32,
        footprintW: 3,
        footprintH: 2,
        isDesk: true,
        backgroundTiles: 1, // its back row is walkable, but no place to stand
      },
    ],
    sprites: { CHAIR: [['']], DESK: [['']] },
  });
  expect(ok).toBe(true);
});

const LABELS: Record<string, string> = {
  D: 'Dev',
  M: 'Meeting',
  E: 'Entrance',
  A: 'Ansh',
  G: 'Manager',
  S: 'Server',
};

/** `W` wall, `.` unlabeled floor, a letter = floor in that Area. */
function layoutFrom(map: string[], furniture: PlacedFurniture[]): OfficeLayout {
  const tiles: TileType[] = [];
  const areaTiles: Array<string | null> = [];
  for (const line of map) {
    for (const ch of line) {
      tiles.push(ch === 'W' ? TileType.WALL : TileType.FLOOR_1);
      areaTiles.push(LABELS[ch] ?? null);
    }
  }
  return { version: 1, cols: map[0].length, rows: map.length, tiles, furniture, areaTiles };
}

/**
 * The real layout's geometry: Ansh's room is cols 1-5, rows 2-7, walled, with
 * an unlabeled two-tile doorway at (6,4),(6,5); Ansh's chair (3,3) faces
 * down at a desk (2-4, 4-5); the Manager's chair (9,4) in its Area outside.
 * Dev desks to the right, Meeting chairs bottom-right.
 */
const MAP = [
  'WWWWWWWWWWWWWWWW',
  'WWWWWWWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAAWDMMMMDDEE',
  'WWWWWWWDMMMMDDDW',
  'WWWWWWWWWWWWWWWW',
];
/** Same office, the room and the Manager's Area just Dev floor. */
const MAP_WITHOUT_ANSH = MAP.map((l) => l.replace(/[AG]/g, 'D'));

const FURNITURE: PlacedFurniture[] = [
  chair('d1', 11, 2),
  chair('d2', 13, 2),
  chair('m1', 9, 8),
  chair('m2', 10, 8),
  chair('ansh', 3, 3),
  { uid: 'ansh-desk', type: 'DESK', col: 2, row: 4 },
  chair('guest', 1, 7), // a second chair in the room: held too
  chair('mgr', 9, 4),
];

const office = (map = MAP, furniture = FURNITURE) => new OfficeState(layoutFrom(map, furniture));
const at = (ch: Character) => [ch.tileCol, ch.tileRow];

function agentAt(os: OfficeState, id: number, seat: string): Character {
  os.addAgent(id, 0, 0, seat, true);
  return os.characters.get(id)!;
}

describe('the rules', () => {
  const NONE = {
    sleeping: false,
    permission: false,
    askingUser: false,
    testing: false,
    longCommand: false,
    onBreak: false,
    active: true,
    waiting: false,
  };

  it('a permission request knocks on Ansh’s door when there is one, else goes to Meeting', () => {
    expect(pickDestination({ ...NONE, permission: true }, { anshDoor: true })).toBe(
      Destination.KNOCK,
    );
    expect(pickDestination({ ...NONE, permission: true }, { anshDoor: false })).toBe(
      Destination.MEETING,
    );
    expect(pickDestination({ ...NONE, permission: true })).toBe(Destination.MEETING);
  });

  it('a question is asked in Meeting, even with a permission pending', () => {
    expect(pickDestination({ ...NONE, askingUser: true }, { anshDoor: true })).toBe(
      Destination.MEETING,
    );
    expect(
      pickDestination({ ...NONE, askingUser: true, permission: true }, { anshDoor: true }),
    ).toBe(Destination.MEETING);
  });
});

describe('knock spots', () => {
  it('the walkable tile just outside the door, facing it, then one step further out', () => {
    const tiles = [
      { col: 1, row: 0 }, // the room's bottom row (row 0) with the door at (1,0)
    ];
    const spots = knockSpots(
      'Ansh',
      tiles,
      (c, r) => c === 1 && r === 0,
      (c, r) => c === 1 && r >= 0 && r <= 2,
    );
    expect(spots.map((s) => [s.col, s.row, s.facing])).toEqual([
      [1, 1, Direction.UP],
      [1, 2, Direction.UP],
    ]);
    expect(spots.every((s) => !s.sit && s.zone === 'Ansh')).toBe(true);
  });

  it('a doorway labeled as part of the room: the first tile outside it', () => {
    // Room cols 1-5 plus its door tiles (6,4),(6,5); walls at col 6 elsewhere.
    const inRoom = (c: number, r: number) =>
      (c >= 1 && c <= 5 && r >= 2 && r <= 7) || (c === 6 && (r === 4 || r === 5));
    const isWall = (c: number, r: number) => c === 6 && !(r === 4 || r === 5);
    const walkable = (c: number, r: number) =>
      c >= 1 && c <= 9 && r >= 2 && r <= 7 && !isWall(c, r);
    const tiles: Array<{ col: number; row: number }> = [];
    for (let r = 2; r <= 7; r++)
      for (let c = 1; c <= 6; c++) if (inRoom(c, r)) tiles.push({ col: c, row: r });
    const spots = knockSpots('Ansh', tiles, inRoom, walkable, isWall);
    expect(spots.map((s) => [s.col, s.row, s.facing])).toEqual([
      [7, 4, Direction.LEFT],
      [7, 5, Direction.LEFT],
      [8, 4, Direction.LEFT],
      [8, 5, Direction.LEFT],
    ]);
  });

  it('an unlabeled doorway is stepped over: the spots are in front of it, front rank first', () => {
    const os = office();
    const ansh = os.zones.zones.get(ZoneLabel.ANSH)!;
    expect(ansh.places.map((p) => [p.col, p.row, p.facing])).toEqual([
      [7, 4, Direction.LEFT],
      [7, 5, Direction.LEFT],
      [8, 4, Direction.LEFT],
      [8, 5, Direction.LEFT],
    ]);
    expect(os.zones.zones.has(ZoneLabel.MANAGER)).toBe(false);
  });
});

describe('permission routing in the office', () => {
  it('knocks at the door — facing it, bobbing — and goes back to work on the answer', () => {
    const os = office();
    const ch = agentAt(os, 1, 'd1');
    os.showPermissionBubble(1);
    run(os, 0.1);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.ANSH);
    run(os, 15);
    expect(at(ch)).toEqual([7, 4]);
    expect(ch.dir).toBe(Direction.LEFT);
    expect(ch.state).toBe(CharacterState.IDLE);
    // Knock knock, every KNOCK_INTERVAL_SEC.
    const bobs = new Set<number>();
    for (let i = 0; i < 40; i++) {
      run(os, KNOCK_INTERVAL_SEC / 40, KNOCK_INTERVAL_SEC / 40);
      bobs.add(knockBobPx(ch));
    }
    expect(bobs).toEqual(new Set([0, KNOCK_BOB_PX]));
    os.clearPermissionBubble(1);
    run(os, 15);
    expect(at(ch)).toEqual([11, 2]);
    expect(knockBobPx(ch)).toBe(0);
  });

  it('more requests queue behind the door; with every spot taken, the next waits in Meeting', () => {
    const os = office(MAP, [
      ...FURNITURE,
      chair('d3', 12, 6),
      chair('d4', 14, 6),
      chair('d5', 13, 4),
    ]);
    const agents = ['d1', 'd2', 'd3', 'd4', 'd5'].map((seat, i) => agentAt(os, i + 1, seat));
    for (let id = 1; id <= 5; id++) os.showPermissionBubble(id);
    run(os, 25);
    const knocking = agents.filter((x) => x.zoneTarget?.zone === ZoneLabel.ANSH);
    expect(knocking.map(at).sort()).toEqual([
      [7, 4],
      [7, 5],
      [8, 4],
      [8, 5],
    ]);
    expect(agents.filter((x) => x.zoneTarget?.zone === ZoneLabel.MEETING)).toHaveLength(1);
  });

  it('AskUserQuestion still goes to Meeting', () => {
    const os = office();
    const ch = agentAt(os, 1, 'd1');
    os.noteToolStart(1, 'q', 'AskUserQuestion', false);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
  });

  it('without an Ansh room, a permission request goes to Meeting as before', () => {
    const os = office(MAP_WITHOUT_ANSH);
    const ch = agentAt(os, 1, 'd1');
    os.showPermissionBubble(1);
    run(os, 15);
    expect(ch.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    expect(ch.state).toBe(CharacterState.TYPE);
  });
});

describe('NPCs', () => {
  it('Ansh sits at the room’s desk and the Manager at the desk outside', () => {
    const os = office();
    const ansh = os.npcs.ansh!;
    const manager = os.npcs.manager!;
    expect(ansh.id).toBe(ANSH_NPC_ID);
    expect(manager.id).toBe(MANAGER_NPC_ID);
    expect(at(ansh)).toEqual([3, 3]);
    expect(ansh.dir).toBe(Direction.DOWN);
    expect(at(manager)).toEqual([9, 4]);
    expect(ansh.state).toBe(CharacterState.TYPE);
    expect(manager.state).toBe(CharacterState.TYPE);
  });

  it('are never agents: not in `characters`, drawn via getCharacters, not hit as agents', () => {
    const os = office();
    agentAt(os, 1, 'd1');
    expect([...os.characters.keys()]).toEqual([1]);
    expect(os.getCharacters().map((c) => c.id)).toEqual([1, ANSH_NPC_ID, MANAGER_NPC_ID]);
    expect(Object.keys(os.getPersistableSeats())).toEqual(['1']);
    const m = os.npcs.manager!;
    expect(os.getCharacterAt(m.x, m.y)).toBeNull();
    expect(os.getNpcAt(m.x, m.y)).toBe('manager');
    const a = os.npcs.ansh!;
    expect(os.getNpcAt(a.x, a.y)).toBe('ansh');
  });

  it('their seats are never given to an agent, even with every other seat taken', () => {
    const os = office();
    for (let id = 1; id <= 6; id++) os.addAgent(id, 0, 0, undefined, true);
    const seats = [...os.characters.values()].map((c) => c.seatId);
    for (const held of ['ansh', 'guest', 'mgr']) expect(seats).not.toContain(held);
    expect(seats.filter((s) => s !== null)).toHaveLength(4);
    // ...nor by a click on one (the canvas only reassigns to a free seat)...
    expect(['ansh', 'guest', 'mgr'].map((uid) => os.seats.get(uid)!.assigned)).toEqual([
      true,
      true,
      true,
    ]);
    // ...and a layout rebuild keeps them held.
    os.rebuildFromLayout(layoutFrom(MAP, FURNITURE));
    const after = [...os.characters.values()].map((c) => c.seatId);
    for (const held of ['ansh', 'guest', 'mgr']) expect(after).not.toContain(held);
  });

  it('are absent without the Areas', () => {
    const os = office(MAP_WITHOUT_ANSH);
    expect(os.npcs.ansh).toBeNull();
    expect(os.npcs.manager).toBeNull();
    expect(os.getCharacters()).toEqual([]);
    expect(os.startManagerVisit()).toBe(false);
  });

  it('report time: the Manager walks to Ansh’s desk, stays a while, and walks back', () => {
    const os = office();
    const m = os.npcs.manager!;
    expect(os.startManagerVisit()).toBe(true);
    // Walks in through the door to the far side of Ansh's desk, facing Ansh.
    let walked = 0;
    while (!(m.tileCol === 3 && m.tileRow === 6 && m.state === CharacterState.IDLE)) {
      run(os, 0.1);
      walked += 0.1;
      expect(walked).toBeLessThan(15);
    }
    expect(m.dir).toBe(Direction.UP);
    expect(os.npcs.visiting).toBe(true);
    // ...stays about MANAGER_VISIT_STAY_SEC...
    run(os, MANAGER_VISIT_STAY_SEC - 0.5);
    expect(at(m)).toEqual([3, 6]);
    // ...and walks back to its own chair.
    run(os, 15);
    expect(at(m)).toEqual([9, 4]);
    expect(m.state).toBe(CharacterState.TYPE);
    expect(os.npcs.visiting).toBe(false);
    // The Manager's chair stayed held throughout.
    expect(os.seats.get('mgr')!.assigned).toBe(true);
  });

  it('places: the Manager may sit beside its Area, and stands in it without a seat', () => {
    const seat = (uid: string, col: number, row: number) => ({
      uid,
      seatCol: col,
      seatRow: row,
      facingDir: Direction.DOWN,
      assigned: false,
    });
    const walkable = () => true;
    const beside = findNpcPlaces({
      seats: new Map([['s', seat('s', 5, 6)]]),
      anshTiles: [{ col: 0, row: 0 }],
      managerTiles: [{ col: 5, row: 5 }],
      walkable,
    });
    expect(beside.managerSeat?.uid).toBe('s');
    const standing = findNpcPlaces({
      seats: new Map(),
      anshTiles: [{ col: 0, row: 0 }],
      managerTiles: [{ col: 5, row: 5 }],
      walkable,
    });
    expect(standing.managerSeat).toBeNull();
    expect(standing.managerStand).toMatchObject({ col: 5, row: 5 });
    expect(standing.anshSeat).toBeNull();
    expect(standing.visitSpot).toMatchObject({ col: 0, row: 0 });
  });
});

describe('Ansh’s thoughts, acted out', () => {
  const thought = (over: Partial<AnshThoughtEntry>): AnshThoughtEntry => ({
    at: 0,
    action: 'stay',
    say: 'Hm.',
    aiWritten: true,
    ...over,
  });
  const dist = (a: Character, b: { col: number; row: number }) =>
    Math.abs(a.tileCol - b.col) + Math.abs(a.tileRow - b.row);
  /** Run until Ansh stands still away from his chair (or fail after 20 s). */
  function untilArrived(os: OfficeState): Character {
    const a = os.npcs.ansh!;
    let t = 0;
    while (!(a.state === CharacterState.IDLE && !a.path.length && os.npcs.anshOut)) {
      run(os, 0.1);
      t += 0.1;
      expect(t).toBeLessThan(20);
    }
    return a;
  }

  it('visit: walks out of his room to the agent, faces it, stays, and walks back to his desk', () => {
    const os = office();
    const agent = agentAt(os, 1, 'd1');
    expect(os.anshDo(thought({ action: 'visit', targetId: 1 }))).toBe(true);
    const a = untilArrived(os);
    expect(dist(a, { col: agent.tileCol, row: agent.tileRow })).toBeLessThanOrEqual(2);
    const dc = agent.tileCol - a.tileCol;
    const dr = agent.tileRow - a.tileRow;
    const facing =
      Math.abs(dc) >= Math.abs(dr)
        ? dc > 0
          ? Direction.RIGHT
          : Direction.LEFT
        : dr > 0
          ? Direction.DOWN
          : Direction.UP;
    expect(a.dir).toBe(facing);
    run(os, ANSH_VISIT_STAY_SEC - 0.5);
    expect(os.npcs.anshOut).toBe(true);
    run(os, 20);
    expect(at(a)).toEqual([3, 3]);
    expect(a.state).toBe(CharacterState.TYPE);
    expect(os.npcs.anshOut).toBe(false);
    // His chair stayed his throughout; the agent was never touched.
    expect(os.seats.get('ansh')!.assigned).toBe(true);
    expect(agent.seatId).toBe('d1');
  });

  it('chatManager: goes over to the Manager and back', () => {
    const os = office();
    expect(os.anshDo(thought({ action: 'chatManager' }))).toBe(true);
    const a = untilArrived(os);
    expect(dist(a, { col: 9, row: 4 })).toBeLessThanOrEqual(2);
    run(os, ANSH_CHAT_STAY_SEC + 20);
    expect(at(a)).toEqual([3, 3]);
  });

  it('stretch: a short walk nearby and back', () => {
    const os = office();
    expect(os.anshDo(thought({ action: 'stretch' }), () => 0.5)).toBe(true);
    const a = untilArrived(os);
    expect(dist(a, { col: 3, row: 3 })).toBeLessThanOrEqual(ANSH_STRETCH_RADIUS_TILES + 1);
    run(os, 30);
    expect(at(a)).toEqual([3, 3]);
  });

  it('stays seated for `stay`, a target no longer on the board, or no Ansh at all', () => {
    const os = office();
    expect(os.anshDo(thought({ action: 'stay' }))).toBe(false);
    expect(os.anshDo(thought({ action: 'visit', targetId: 42 }))).toBe(false);
    expect(os.npcs.anshOut).toBe(false);
    expect(at(os.npcs.ansh!)).toEqual([3, 3]);
    expect(office(MAP_WITHOUT_ANSH).anshDo(thought({ action: 'chatManager' }))).toBe(false);
  });
});

describe('Ansh wanders between thoughts', () => {
  /** The same office with a Server room (no racks: any of its tiles) top-right. */
  const MAP_WITH_SERVER = MAP.map((l, row) => (row === 1 ? 'WWWWWWWDDDDDSSSW' : l));
  const inServer = (ch: Character) => ch.tileRow === 1 && ch.tileCol >= 12 && ch.tileCol <= 14;

  it('walks to a place in the Server room, stays a while, and walks back to his desk', () => {
    const os = office(MAP_WITH_SERVER);
    // On offer: a chat with the Manager (weight 2), a place (1), a stretch (1).
    expect(os.anshWander(() => 0.6)).toBe(true);
    const a = os.npcs.ansh!;
    let t = 0;
    while (!(inServer(a) && a.state === CharacterState.IDLE && !a.path.length)) {
      run(os, 0.1);
      t += 0.1;
      expect(t).toBeLessThan(20);
    }
    run(os, ANSH_WANDER_STAY_SEC - 0.5);
    expect(inServer(a)).toBe(true);
    run(os, 25);
    expect(at(a)).toEqual([3, 3]);
    expect(a.state).toBe(CharacterState.TYPE);
    expect(os.npcs.anshOut).toBe(false);
  });

  it('stretches nearby when the office has nowhere to go', () => {
    const os = office();
    // On offer: a chat with the Manager (weight 2) and a stretch (1).
    expect(os.anshWander(() => 0.9)).toBe(true);
    expect(os.npcs.anshOut).toBe(true);
    run(os, 30);
    expect(at(os.npcs.ansh!)).toEqual([3, 3]);
    expect(office(MAP_WITHOUT_ANSH).anshWander(() => 0)).toBe(false);
  });

  it('sets off on his own after sitting ANSH_WANDER_MIN_SEC at the shortest', () => {
    const os = office(MAP_WITH_SERVER);
    os.anshWanderRandom = () => 0;
    run(os, ANSH_WANDER_MIN_SEC - 1);
    expect(os.npcs.anshOut).toBe(false);
    run(os, 2);
    expect(os.npcs.anshOut).toBe(true);
  });

  it('stays at his desk while the Manager is coming to it', () => {
    const os = office();
    os.anshWanderRandom = () => 0;
    // A second from wandering when the Manager sets off.
    run(os, ANSH_WANDER_MIN_SEC - 1);
    expect(os.startManagerVisit()).toBe(true);
    let t = 0;
    while (os.npcs.visiting) {
      run(os, 0.1);
      t += 0.1;
      expect(os.npcs.anshOut).toBe(false);
      expect(t).toBeLessThan(60);
    }
  });

  it('a thought cuts into a wander', () => {
    const os = office(MAP_WITH_SERVER);
    const agent = agentAt(os, 1, 'd1');
    expect(os.anshWander(() => 0)).toBe(true);
    run(os, 1);
    expect(os.anshDo({ at: 0, action: 'visit', targetId: 1, say: 'Hm.', aiWritten: true })).toBe(
      true,
    );
    const a = os.npcs.ansh!;
    let t = 0;
    while (!(a.state === CharacterState.IDLE && !a.path.length)) {
      run(os, 0.1);
      t += 0.1;
      expect(t).toBeLessThan(20);
    }
    const d = Math.abs(a.tileCol - agent.tileCol) + Math.abs(a.tileRow - agent.tileRow);
    expect(d).toBeLessThanOrEqual(2);
  });
});
