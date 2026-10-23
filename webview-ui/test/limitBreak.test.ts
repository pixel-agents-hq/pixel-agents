/**
 * The limit break (fun/limitBreak.ts): agents the session limit cut off
 * gather in the Lounge — with the Manager and Ansh — and rotate through its
 * pastimes (sofa chat, pizza, coffee, the shelves, ping-pong) until the limit
 * resets. The pure rules, then the FunDirector + NPCs in a small office.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { MANAGER_NPC_ID } from '../src/constants.js';
import {
  BREAK_ACTIVITY_MAX_SEC,
  BREAK_AGENT_LINES,
  BREAK_ANSH_LINES,
} from '../src/fun/funConstants.js';
import type { BreakActivity } from '../src/fun/limitBreak.js';
import {
  breakLine,
  breakSignText,
  isBreakReason,
  pickBreakActivity,
} from '../src/fun/limitBreak.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { Character, OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import { ZoneLabel } from '../src/office/zones.js';
import { chair } from './livingOfficeFixture.js';

// ════════════════════════════════════════════════════════════════
// Pure rules
// ════════════════════════════════════════════════════════════════

describe('limit break rules', () => {
  it('the session limit (and an unnamed usage limit) count; weekly and rate limits do not', () => {
    expect(isBreakReason('session')).toBe(true);
    expect(isBreakReason('usage')).toBe(true);
    expect(isBreakReason('weekly')).toBe(false);
    expect(isBreakReason('rate')).toBe(false);
    expect(isBreakReason(undefined)).toBe(false);
  });

  it('picks by weight among what is on, never the activity just done', () => {
    const all = new Set<BreakActivity>(['sofa', 'pizza', 'coffee', 'shelves', 'pingpong']);
    expect(pickBreakActivity(all, undefined, () => 0)).toBe('sofa');
    expect(pickBreakActivity(all, undefined, () => 0.99)).toBe('pingpong');
    expect(pickBreakActivity(all, 'sofa', () => 0)).toBe('pizza');
    for (let i = 0; i < 20; i++) {
      expect(pickBreakActivity(all, 'coffee', () => i / 20)).not.toBe('coffee');
    }
    // Only the last one on: again rather than nothing.
    expect(pickBreakActivity(new Set(['sofa']), 'sofa', () => 0.5)).toBe('sofa');
    expect(pickBreakActivity(new Set(), undefined, () => 0.5)).toBeNull();
  });

  it('the sign says when they are back, or just that they are on a break', () => {
    const now = new Date(2026, 9, 19, 14, 0).getTime();
    const reset = new Date(2026, 9, 19, 18, 30).getTime();
    expect(breakSignText(reset, now)).toBe('Back at 6:30 pm');
    expect(breakSignText(undefined, now)).toBe('On a break');
    expect(breakSignText(now - 1, now)).toBe('On a break');
  });

  it('fills the reset time into a line', () => {
    const now = new Date(2026, 9, 19, 14, 0).getTime();
    const reset = new Date(2026, 9, 19, 18, 30).getTime();
    const i = BREAK_ANSH_LINES.findIndex((l) => l.includes('{time}'));
    const pick = () => (i + 0.5) / BREAK_ANSH_LINES.length;
    expect(breakLine('ansh', reset, now, pick)).toContain('6:30 pm');
    expect(breakLine('ansh', undefined, now, pick)).toContain('the reset');
    expect(BREAK_AGENT_LINES).toContain(
      breakLine(7, reset, now, () => 0).replace('6:30 pm', '{time}'),
    );
  });
});

// ════════════════════════════════════════════════════════════════
// The director + NPCs in a small office
// ════════════════════════════════════════════════════════════════

type CatalogAsset = LoadedAssetData['catalog'][number];
const asset = (id: string, over: Partial<CatalogAsset> = {}): CatalogAsset => ({
  id,
  label: id,
  category: 'misc',
  width: 16,
  height: 16,
  footprintW: 1,
  footprintH: 1,
  isDesk: false,
  ...over,
});

beforeAll(() => {
  const assets = [
    asset('CHAIR', { category: 'chairs' }),
    asset('DESK', {
      category: 'desks',
      footprintW: 3,
      footprintH: 2,
      isDesk: true,
      backgroundTiles: 1,
    }),
    asset('TABLE', { category: 'desks', footprintW: 2, isDesk: true }),
    asset('COFFEE', { canPlaceOnSurfaces: true }),
    asset('PIZZA_BOX', { canPlaceOnSurfaces: true }),
    asset('PIZZA_BOX_OPEN', { canPlaceOnSurfaces: true }),
    asset('PING_PONG_TABLE', { footprintW: 2 }),
    asset('BOOKSHELF'),
  ];
  const sprites: Record<string, string[][]> = {};
  for (const a of assets) sprites[a.id] = [['']];
  expect(buildDynamicCatalog({ catalog: assets, sprites })).toBe(true);
});

const LABELS: Record<string, string> = { D: 'Dev', L: 'Lounge', A: 'Ansh', G: 'Manager' };

/**
 * Ansh's room top-left (his chair (3,3) at a desk, a doorway at (6,4)/(6,5)),
 * the Manager's chair (9,4), Dev desks, and the Lounge along the bottom:
 * four chairs at a table holding a mug, a ping-pong table, a bookshelf.
 */
const MAP = [
  'WWWWWWWWWWWWWWWW',
  'WWWWWWWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WWWWWWWDDDDDDDDW',
  'WLLLLLLLLLLLLLLW',
  'WLLLLLLLLLLLLLLW',
  'WLLLLLLLLLLLLLLW',
  'WLLLLLLLLLLLLLLW',
  'WWWWWWWWWWWWWWWW',
];

const FURNITURE: PlacedFurniture[] = [
  chair('ansh', 3, 3),
  { uid: 'ansh-desk', type: 'DESK', col: 2, row: 4 },
  chair('mgr', 9, 4),
  chair('d1', 8, 2),
  chair('d2', 11, 2),
  chair('d3', 13, 2),
  chair('d4', 12, 6),
  chair('s1', 2, 10),
  chair('s2', 3, 10),
  chair('s3', 4, 10),
  chair('s4', 5, 10),
  { uid: 'table', type: 'TABLE', col: 3, row: 11 },
  { uid: 'mug', type: 'COFFEE', col: 3, row: 11 },
  { uid: 'pingpong', type: 'PING_PONG_TABLE', col: 10, row: 10 },
  { uid: 'shelf', type: 'BOOKSHELF', col: 13, row: 9 },
];

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

const START = new Date(2026, 9, 19, 14, 0);
const RESET = new Date(2026, 9, 19, 18, 30).getTime();

function office(map = MAP, random = () => 0): { os: OfficeState; clock: { ms: number } } {
  const os = new OfficeState(layoutFrom(map, FURNITURE));
  const clock = { ms: START.getTime() };
  os.nowMs = () => clock.ms;
  os.zoneRandom = random;
  return { os, clock };
}

function tick(os: OfficeState, clock: { ms: number }, seconds: number, dt = 0.05): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    clock.ms += dt * 1000;
    os.update(dt);
  }
}

function idleAgent(os: OfficeState, id: number, seat: string): Character {
  os.addAgent(id, 0, 0, seat, true);
  os.setAgentActive(id, false);
  return os.characters.get(id)!;
}

const limit = (
  os: OfficeState,
  id: number,
  reason = 'session',
  resetsAt: number | undefined = RESET,
) => os.fun.onMessage({ type: 'agentLimit', id, paused: true, reason, resetsAt });
const unlimit = (os: OfficeState, id: number) =>
  os.fun.onMessage({ type: 'agentLimit', id, paused: false });

const inLounge = (os: OfficeState, ch: Character) =>
  os.fun.zoneAt(ch.tileCol, ch.tileRow) === ZoneLabel.LOUNGE;
const placed = (os: OfficeState) => os.fun.decorate(os.getLayout().furniture);

describe('the limit break: who goes', () => {
  it('an agent the session limit cut off goes to sit in the Lounge', () => {
    const { os, clock } = office();
    const a = idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 1);
    expect(os.fun.breakOn).toBe(true);
    expect(os.fun.borrows.get(1)).toMatchObject({ kind: 'limitBreak', activity: 'sofa' });
    tick(os, clock, 20);
    expect(inLounge(os, a)).toBe(true);
    expect(a.zoneTarget?.sit).toBe(true);
  });

  it('a weekly or rate limit does not, and an agent that never hit a limit stays put', () => {
    const { os, clock } = office(MAP, () => 0.99); // no chance-driven pastimes either
    idleAgent(os, 1, 'd1');
    idleAgent(os, 2, 'd2');
    idleAgent(os, 3, 'd3');
    limit(os, 1, 'weekly');
    limit(os, 2, 'rate');
    tick(os, clock, 5);
    expect(os.fun.breakOn).toBe(false);
    expect(os.fun.borrows.size).toBe(0);
  });

  it('no Lounge, no break: they wait at their desks as before', () => {
    const { os, clock } = office(MAP.map((l) => l.replace(/L/g, 'D')));
    idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 5);
    expect(os.fun.breakOn).toBe(false);
    expect(os.fun.borrows.size).toBe(0);
  });

  it('sub-agents and agents at work do not join', () => {
    const { os, clock } = office();
    os.addAgent(1, 0, 0, 'd1', true); // active
    limit(os, 1);
    tick(os, clock, 2);
    expect(os.fun.borrows.size).toBe(0);
  });

  it('the reset, a permission request or closing the agent lets it go', () => {
    const { os, clock } = office();
    idleAgent(os, 1, 'd1');
    idleAgent(os, 2, 'd2');
    idleAgent(os, 3, 'd3');
    for (const id of [1, 2, 3]) limit(os, id);
    tick(os, clock, 2);
    expect(os.fun.borrows.size).toBe(3);

    unlimit(os, 1);
    os.fun.onMessage({ type: 'agentToolPermission', id: 2 });
    os.fun.onMessage({ type: 'agentClosed', id: 3 });
    tick(os, clock, 1);
    expect(os.fun.borrows.size).toBe(0);
    expect(os.fun.breakOn).toBe(false);
  });
});

describe('the limit break: what they do', () => {
  it('goes from one activity straight to the next, never back to the desk, never the same twice', () => {
    // A seeded walk through the weights.
    let seed = 7;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const { os, clock } = office(MAP, rng);
    idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 1);
    const seen: BreakActivity[] = [];
    for (let i = 0; i < Math.round((BREAK_ACTIVITY_MAX_SEC * 6) / 0.5); i++) {
      tick(os, clock, 0.5);
      const b = os.fun.borrows.get(1);
      expect(b?.kind).toBe('limitBreak'); // always on something
      if (b?.activity && b.activity !== seen[seen.length - 1]) seen.push(b.activity);
    }
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2);
    // One agent alone never plays ping-pong.
    expect(seen).not.toContain('pingpong');
  });

  it('two on the break can play ping-pong on the Lounge table', () => {
    const { os, clock } = office(MAP, () => 0.99); // the last weight: ping-pong
    idleAgent(os, 1, 'd1');
    idleAgent(os, 2, 'd2');
    limit(os, 1);
    limit(os, 2);
    tick(os, clock, 1);
    expect(os.fun.borrows.get(1)?.kind).toBe('pingpong');
    expect(os.fun.borrows.get(2)?.kind).toBe('pingpong');
    const ends = [os.fun.borrows.get(1)!.target, os.fun.borrows.get(2)!.target].map((t) => t.col);
    expect(ends.sort((x, y) => x - y)).toEqual([9, 12]); // either end of the table at (10-11, 10)
  });

  it('a pizza box goes on the Lounge table for the break, and away after it', () => {
    const { os, clock } = office();
    idleAgent(os, 1, 'd1');
    expect(placed(os).some((f) => f.type === 'PIZZA_BOX_OPEN')).toBe(false);
    limit(os, 1);
    tick(os, clock, 1);
    // The mug has (3,11); the table's other tile is free.
    expect(placed(os).find((f) => f.type === 'PIZZA_BOX_OPEN')).toMatchObject({ col: 4, row: 11 });
    unlimit(os, 1);
    tick(os, clock, 1);
    expect(placed(os).some((f) => f.type === 'PIZZA_BOX_OPEN')).toBe(false);
  });

  it('a coffee: a seat by the mug, cup in hand once sat', () => {
    // Alone (no ping-pong): sofa 3, pizza 1, coffee 1, shelves 1 — 4.5 of 6 is coffee.
    const { os, clock } = office(MAP, () => 4.5 / 6);
    const a = idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 1);
    expect(os.fun.borrows.get(1)?.activity).toBe('coffee');
    expect(a.carryingCup).toBeUndefined();
    tick(os, clock, 25);
    expect(a.carryingCup).toBe(true);
  });

  it('the sign: when they are back (the earliest reset), else just a break', () => {
    const { os, clock } = office();
    idleAgent(os, 1, 'd1');
    idleAgent(os, 2, 'd2');
    expect(os.fun.breakSign()).toBeNull();
    limit(os, 1, 'session', RESET + 60 * 60 * 1000);
    limit(os, 2, 'session', RESET);
    tick(os, clock, 0.5);
    expect(os.fun.breakSign()).toMatchObject({ text: 'Back at 6:30 pm', row: 9 });
    unlimit(os, 1);
    unlimit(os, 2);
    os.fun.onMessage({ type: 'agentLimit', id: 1, paused: true, reason: 'usage' });
    tick(os, clock, 0.5);
    expect(os.fun.breakSign()?.text).toBe('On a break');
  });
});

describe('the limit break: the Manager and Ansh', () => {
  it('both walk over to sit with the break, and nobody is given their seats', () => {
    const { os, clock } = office();
    const agents = [idleAgent(os, 1, 'd1'), idleAgent(os, 2, 'd2')];
    for (const a of agents) limit(os, a.id);
    tick(os, clock, 40);
    const { ansh, manager } = os.npcs;
    expect(os.npcs.atHangout('manager')).toBe(true);
    expect(os.npcs.atHangout('ansh')).toBe(true);
    expect(inLounge(os, ansh!)).toBe(true);
    expect(inLounge(os, manager!)).toBe(true);
    const npcTiles = [ansh!, manager!].map((c) => `${c.tileCol},${c.tileRow}`);
    for (const a of agents) {
      expect(npcTiles).not.toContain(`${a.tileCol},${a.tileRow}`);
      expect(os.fun.borrows.get(a.id)?.target.key).not.toBe(undefined);
    }
  });

  it('while there, no errands, no thoughts moving Ansh, no report visit', () => {
    const { os, clock } = office();
    idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 40);
    expect(os.startManagerVisit()).toBe(false);
    expect(
      os.anshDo({ at: clock.ms, action: 'visit', targetId: 1, say: 'hi', aiWritten: false }),
    ).toBe(false);
    expect(os.anshWander(() => 0)).toBe(false);
    expect(os.npcs.atHangout('ansh')).toBe(true);
  });

  it('they chat: lines from the agents and the NPCs', () => {
    let seed = 11;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const { os, clock } = office(MAP, rng);
    idleAgent(os, 1, 'd1');
    idleAgent(os, 2, 'd2');
    limit(os, 1);
    limit(os, 2);
    const who = new Set<string>();
    for (let i = 0; i < 240; i++) {
      tick(os, clock, 0.5);
      for (const l of os.breakSpeechShowing()) who.add(l.npc ?? 'agent');
    }
    expect(who.has('agent')).toBe(true);
    expect(who.has('ansh') || who.has('manager')).toBe(true);
  });

  it('after the reset they walk back to their desks and free the Lounge seats', () => {
    const { os, clock } = office();
    idleAgent(os, 1, 'd1');
    limit(os, 1);
    tick(os, clock, 40);
    const manager = os.npcs.manager!;
    const held = os.fun.claimGuestSeat('manager', manager)!;
    expect(os.seats.get(held.key)?.assigned).toBe(true);
    unlimit(os, 1);
    tick(os, clock, 40);
    expect(os.npcs.inHangout('manager')).toBe(false);
    expect(os.npcs.inHangout('ansh')).toBe(false);
    expect([manager.tileCol, manager.tileRow]).toEqual([9, 4]);
    expect([os.npcs.ansh!.tileCol, os.npcs.ansh!.tileRow]).toEqual([3, 3]);
    expect(os.seats.get(held.key)?.assigned).toBe(false);
    expect(os.startManagerVisit()).toBe(true); // back to normal
    expect(manager.id).toBe(MANAGER_NPC_ID);
  });
});
