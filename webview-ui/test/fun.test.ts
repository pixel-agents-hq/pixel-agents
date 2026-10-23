/**
 * The fun phase (docs/office/DESIGN.md, phases E and F): the pure rules —
 * festival dates and decorations, ritual timing, plant stages, the week wall,
 * pet goals, ping-pong pairs, weather in the windows, the printer, the fish
 * tank, the lo-fi pattern — and the FunDirector driving a small zoned office
 * (standup, whiteboard, library, plants, pizza, printer, Gitcat on a desk).
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { DecorInput } from '../src/fun/festivals.js';
import {
  FESTIVAL_DATES,
  festivalDecorations,
  festivalOn,
  freeSurfaceTiles,
  topWallColumns,
} from '../src/fun/festivals.js';
import {
  busiestAgent,
  calendarCells,
  claudioGoal,
  eveningBannerText,
  fishFrameInterval,
  gitcatGoal,
  isShipStatus,
  mayFollowSmoker,
  monthLabel,
  pickRallyPair,
  plantStage,
  printsDocument,
  rallyEligible,
  ritualDue,
  weatherVisual,
  weekPrCount,
  weekStartKey,
} from '../src/fun/funRules.js';
import { lofiStep, LOOP_STEPS, STEPS_PER_BAR } from '../src/fun/lofiPattern.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { createPet } from '../src/office/engine/petEntity.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { Character, PlacedFurniture } from '../src/office/types.js';
import { ZoneLabel } from '../src/office/zones.js';
import { chair, layoutFrom, OFFICE_MAP } from './livingOfficeFixture.js';

/** Local time on a date (months 1-based). */
const local = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s);

// ════════════════════════════════════════════════════════════════
// Pure rules
// ════════════════════════════════════════════════════════════════

describe('festival dates', () => {
  it('knows Diwali 2026 and 2027 (Dhanteras → Bhai Dooj around Lakshmi Puja)', () => {
    expect(festivalOn(local(2026, 11, 8))).toBe('diwali');
    expect(festivalOn(local(2026, 11, 6))).toBe('diwali');
    expect(festivalOn(local(2026, 11, 10))).toBe('diwali');
    expect(festivalOn(local(2026, 11, 5))).toBeNull();
    expect(festivalOn(local(2026, 11, 11))).toBeNull();
    expect(festivalOn(local(2027, 10, 29))).toBe('diwali');
    expect(festivalOn(local(2026, 10, 18))).toBeNull();
  });

  it('knows Holi 2026 and 2027 (Holika Dahan + the colour day)', () => {
    expect(festivalOn(local(2026, 3, 3))).toBe('holi');
    expect(festivalOn(local(2026, 3, 4))).toBe('holi');
    expect(festivalOn(local(2026, 3, 5))).toBeNull();
    expect(festivalOn(local(2027, 3, 21))).toBe('holi');
    expect(festivalOn(local(2027, 3, 22))).toBe('holi');
  });

  it('New Year runs 31 Dec to 2 Jan every year', () => {
    expect(festivalOn(local(2026, 12, 31, 23, 59))).toBe('newYear');
    expect(festivalOn(local(2027, 1, 1, 0, 0))).toBe('newYear');
    expect(festivalOn(local(2030, 1, 2))).toBe('newYear');
    expect(festivalOn(local(2027, 1, 3))).toBeNull();
    expect(festivalOn(local(2026, 12, 30))).toBeNull();
  });

  it('keeps its table ordered and well-formed', () => {
    for (const row of FESTIVAL_DATES) {
      expect(row.from <= row.to).toBe(true);
      expect(row.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('festival decorations', () => {
  // 8×6: wall row 1 above Dev (cols 1-3) and Lounge (cols 5-7) floor; row 0 is void.
  const zones = ['........', 'WWWWWWWW', 'WDDDWLLL', 'WDDDWLLL', 'WDDDWLLL', 'WWWWWWWW'];
  const entries: Record<
    string,
    { w: number; h: number; isDesk: boolean; onWall: boolean; onSurface: boolean }
  > = {
    DESK: { w: 2, h: 1, isDesk: true, onWall: false, onSurface: false },
    TABLE: { w: 1, h: 1, isDesk: true, onWall: false, onSurface: false },
    PC: { w: 1, h: 1, isDesk: false, onWall: false, onSurface: true },
    CLOCK: { w: 1, h: 2, isDesk: false, onWall: true, onSurface: false },
  };
  const input = (furniture: DecorInput['furniture']): DecorInput => ({
    cols: 8,
    rows: 6,
    isWall: (c, r) => zones[r]?.[c] === 'W',
    zoneAt: (c, r) => ({ D: 'Dev', L: 'Lounge' })[zones[r]?.[c] as 'D' | 'L'] ?? null,
    furniture,
    entry: (type) => entries[type],
  });

  it('finds each room’s top wall, where wall items hang (bottom row on the wall)', () => {
    expect(topWallColumns(input([]), 'Dev')).toEqual([
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ]);
  });

  it('Diwali: string lights along Dev + Lounge top walls (not over a clock), diyas on free desk tiles', () => {
    const furniture = [
      { type: 'CLOCK', col: 2, row: 0 },
      { type: 'DESK', col: 1, row: 3 },
      { type: 'PC', col: 1, row: 3 },
      { type: 'TABLE', col: 6, row: 3 },
    ];
    const decor = festivalDecorations('diwali', input(furniture));
    const lights = decor.filter((d) => d.type.startsWith('STRING_LIGHTS'));
    expect(lights.map((d) => d.col)).toEqual([1, 3, 5, 6, 7]);
    expect(lights.every((d) => d.row === 0)).toBe(true);
    const diyas = decor.filter((d) => d.type.startsWith('DIYA'));
    // The PC's tile is taken; the desk's other tile and the Lounge table are free.
    expect(diyas.map((d) => [d.col, d.row])).toEqual([
      [2, 3],
      [6, 3],
    ]);
    expect(freeSurfaceTiles(input(furniture), ['Lounge'])).toEqual([{ col: 6, row: 3 }]);
  });

  it('Holi: colour bowls on Lounge/Cafe tables; New Year: one banner on the Lounge top wall', () => {
    const furniture = [{ type: 'TABLE', col: 6, row: 3 }];
    expect(festivalDecorations('holi', input(furniture))).toEqual([
      { type: 'HOLI_COLORS', col: 6, row: 3 },
    ]);
    expect(festivalDecorations('newYear', input(furniture))).toEqual([
      { type: 'NEW_YEAR_BANNER', col: 5, row: 0 },
    ]);
    expect(festivalDecorations(null, input(furniture))).toEqual([]);
  });
});

describe('rituals', () => {
  it('a ritual is due from its time for the grace minutes, once a day', () => {
    expect(ritualDue(local(2026, 10, 19, 9, 59, 59), 10, 0, undefined)).toBe(false);
    expect(ritualDue(local(2026, 10, 19, 10, 0), 10, 0, undefined)).toBe(true);
    expect(ritualDue(local(2026, 10, 19, 10, 4, 59), 10, 0, undefined)).toBe(true);
    expect(ritualDue(local(2026, 10, 19, 10, 5), 10, 0, undefined)).toBe(false);
    expect(ritualDue(local(2026, 10, 19, 10, 1), 10, 0, '2026-10-19')).toBe(false);
    expect(ritualDue(local(2026, 10, 20, 10, 1), 10, 0, '2026-10-19')).toBe(true);
    expect(ritualDue(local(2026, 10, 19, 19, 0), 19, 0, undefined)).toBe(true);
  });

  it('writes the evening banner', () => {
    expect(eveningBannerText(3, 5)).toBe('Today: 3 PRs · 5 pushes 🎉');
    expect(eveningBannerText(1, 1)).toBe('Today: 1 PR · 1 push 🎉');
    expect(eveningBannerText(0, 0)).toBe('Today: 0 PRs · 0 pushes 🎉');
  });
});

describe('growing plants and the week wall', () => {
  const day = (date: string, prs: number) => ({ date, prs, pushes: 0, activeMs: 0 });

  it('stages: 0–2 PRs → 1, 3–6 → 2, 7+ → 3', () => {
    expect([0, 2, 3, 6, 7, 20].map(plantStage)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('counts this week’s PRs from Monday (a Sunday still belongs to the week before)', () => {
    expect(weekStartKey(local(2026, 10, 18))).toBe('2026-10-12'); // Sunday → that Monday
    expect(weekStartKey(local(2026, 10, 19))).toBe('2026-10-19'); // Monday
    const week = [
      day('2026-10-16', 4),
      day('2026-10-18', 1),
      day('2026-10-19', 2),
      day('2026-10-20', 3),
    ];
    expect(weekPrCount(week, local(2026, 10, 18))).toBe(5);
    expect(weekPrCount(week, local(2026, 10, 20))).toBe(5); // reset on Monday
  });

  it('lights the calendar cells for days with PRs, Monday-first, marking today and streaks', () => {
    const now = local(2026, 10, 18); // Oct 2026 starts on a Thursday (col 3)
    const cells = calendarCells(
      [day('2026-10-01', 2), day('2026-10-16', 1), day('2026-10-17', 1)],
      now,
    );
    expect(cells.find((c) => c.day === 1)).toMatchObject({ col: 3, row: 0, prs: 2, streak: false });
    expect(cells.find((c) => c.day === 16)).toMatchObject({ col: 4, row: 2, streak: true });
    expect(cells.find((c) => c.day === 18)).toMatchObject({ col: 6, row: 2, today: true, prs: 0 });
    expect(cells).toHaveLength(4);
    expect(monthLabel(now)).toBe('OCT');
    // A sixth week wraps into the first row: 31 Aug 2026 (Aug starts on a Saturday).
    expect(calendarCells([day('2026-08-31', 1)], local(2026, 8, 31))[0]).toMatchObject({
      col: 0,
      row: 0,
    });
  });
});

describe('smart pets', () => {
  it('busiest = most tool starts in the last 10 minutes among eligible agents', () => {
    const now = 1_000_000;
    const starts = new Map<number, number[]>([
      [1, [now - 1000, now - 2000]],
      [2, [now - 500, now - 700, now - 900]],
      [3, [now - 11 * 60_000, now - 12 * 60_000, now - 13 * 60_000, now - 14 * 60_000]],
    ]);
    expect(busiestAgent(starts, now, 10 * 60_000, () => true)).toBe(2);
    expect(busiestAgent(starts, now, 10 * 60_000, (id) => id !== 2)).toBe(1);
    expect(busiestAgent(new Map(), now, 10 * 60_000, () => true)).toBeNull();
  });

  it('Gitcat: terrace follow > busiest desk > nap beside a sleeper (nobody busy) > roam', () => {
    expect(gitcatGoal({ following: 4, busiest: 2, anyoneBusy: true, sleepers: [] })).toEqual({
      kind: 'terrace',
      agentId: 4,
    });
    expect(gitcatGoal({ following: null, busiest: 2, anyoneBusy: true, sleepers: [3] })).toEqual({
      kind: 'desk',
      agentId: 2,
    });
    expect(
      gitcatGoal({ following: null, busiest: null, anyoneBusy: false, sleepers: [3] }),
    ).toEqual({
      kind: 'nap',
      agentId: 3,
    });
    expect(gitcatGoal({ following: null, busiest: null, anyoneBusy: true, sleepers: [3] })).toEqual(
      {
        kind: 'roam',
      },
    );
  });

  it('follows a smoker at most once an hour, by chance', () => {
    expect(mayFollowSmoker(null, 100, 3600, 0.35, () => 0.1)).toBe(true);
    expect(mayFollowSmoker(null, 100, 3600, 0.35, () => 0.9)).toBe(false);
    expect(mayFollowSmoker(0, 3599, 3600, 0.35, () => 0)).toBe(false);
    expect(mayFollowSmoker(0, 3600, 3600, 0.35, () => 0)).toBe(true);
  });

  it('Claudio: celebrate a ship over greeting, each only while it lasts', () => {
    const celebrate = { agentId: 1, until: 100 };
    const greet = { agentId: 2, until: 100 };
    expect(claudioGoal({ celebrate, greet }, 50)).toEqual({ kind: 'celebrate', agentId: 1 });
    expect(claudioGoal({ celebrate: null, greet }, 50)).toEqual({ kind: 'greet', agentId: 2 });
    expect(claudioGoal({ celebrate, greet }, 100)).toEqual({ kind: 'roam' });
    expect(isShipStatus('Running: git push origin main')).toBe(true);
    expect(isShipStatus('Running: gh pr create --fill')).toBe(true);
    expect(isShipStatus('Running: git status')).toBe(false);
  });
});

describe('ping-pong', () => {
  const idle = (id: number, over: Partial<Parameters<typeof rallyEligible>[0]> = {}) => ({
    id,
    idleAwake: true,
    smokingSec: null,
    midWorkBreak: false,
    ...over,
  });

  it('eligible: idle and awake, not mid-cigarette, never on a mid-work break', () => {
    expect(rallyEligible(idle(1))).toBe(true);
    expect(rallyEligible(idle(1, { idleAwake: false }))).toBe(false);
    expect(rallyEligible(idle(1, { smokingSec: 20 }))).toBe(false);
    expect(rallyEligible(idle(1, { smokingSec: 95 }))).toBe(true);
    expect(rallyEligible(idle(1, { midWorkBreak: true, smokingSec: 200 }))).toBe(false);
  });

  it('needs two players, the cooldown over (≤1 rally / 30 min), and a lucky roll', () => {
    const rng = () => 0.1;
    expect(pickRallyPair([idle(1)], null, 0, 1800, 0.35, rng)).toBeNull();
    expect(
      pickRallyPair([idle(1), idle(2, { idleAwake: false })], null, 0, 1800, 0.35, rng),
    ).toBeNull();
    const pair = pickRallyPair([idle(1), idle(2), idle(3)], null, 0, 1800, 0.35, rng);
    expect(pair).not.toBeNull();
    expect(new Set(pair!).size).toBe(2);
    expect(pickRallyPair([idle(1), idle(2)], 100, 1000, 1800, 0.35, rng)).toBeNull();
    expect(pickRallyPair([idle(1), idle(2)], 100, 1900, 1800, 0.35, rng)).not.toBeNull();
    expect(pickRallyPair([idle(1), idle(2)], null, 0, 1800, 0.35, () => 0.5)).toBeNull();
  });
});

describe('weather, printer, fish tank, radio', () => {
  it('maps the weather to what the panes show', () => {
    expect(weatherVisual('clear', true)).toMatchObject({
      particles: null,
      cloudAlpha: 0,
      fogAlpha: 0,
    });
    expect(weatherVisual('rain', true)).toMatchObject({ particles: 'rain', lightning: false });
    expect(weatherVisual('snow', true).particles).toBe('snow');
    expect(weatherVisual('fog', true).fogAlpha).toBeGreaterThan(0);
    expect(weatherVisual('clouds', true).cloudAlpha).toBeGreaterThan(
      weatherVisual('clouds', false).cloudAlpha,
    );
    expect(weatherVisual('storm', false)).toMatchObject({ particles: 'rain', lightning: true });
  });

  it('prints on a Write of .md / .pdf / .docx / .txt only', () => {
    expect(printsDocument('Write', 'Writing notes.md')).toBe(true);
    expect(printsDocument('Write', 'Writing REPORT.PDF')).toBe(true);
    expect(printsDocument(undefined, 'Writing plan.docx')).toBe(true);
    expect(printsDocument('Write', 'Writing todo.txt')).toBe(true);
    expect(printsDocument('Write', 'Writing app.ts')).toBe(false);
    expect(printsDocument('Edit', 'Editing notes.md')).toBe(false);
  });

  it('bubbles faster with more agents at work', () => {
    expect(fishFrameInterval(0)).toBeGreaterThan(fishFrameInterval(2));
    expect(fishFrameInterval(2)).toBeGreaterThan(fishFrameInterval(4));
    expect(fishFrameInterval(50)).toBe(fishFrameInterval(100)); // floored
  });

  it('plays a 4-bar loop: a chord and a kick on every downbeat, snares on 2 and 4', () => {
    for (let bar = 0; bar < LOOP_STEPS / STEPS_PER_BAR; bar++) {
      const s = lofiStep(bar * STEPS_PER_BAR);
      expect(s.chord?.length).toBe(4);
      expect(s.kick).toBe(true);
      expect(s.bass).not.toBeNull();
      expect(lofiStep(bar * STEPS_PER_BAR + 4).snare).toBe(true);
      expect(lofiStep(bar * STEPS_PER_BAR + 12).snare).toBe(true);
    }
    expect(lofiStep(LOOP_STEPS)).toEqual(lofiStep(0));
    expect(lofiStep(-1)).toEqual(lofiStep(LOOP_STEPS - 1));
  });
});

// ════════════════════════════════════════════════════════════════
// The director in a small zoned office
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

function installFunCatalog(): void {
  const fish = { category: 'decor', groupId: 'FISH_TANK' };
  const printer = { category: 'electronics', groupId: 'PRINTER', canPlaceOnSurfaces: true };
  const assets = [
    asset('CHAIR', { category: 'chairs' }),
    asset('ASHTRAY_STAND', { height: 32, footprintH: 2, backgroundTiles: 1 }),
    asset('TEST_DESK', { category: 'desks', footprintW: 3, isDesk: true }),
    asset('TEST_TABLE', { category: 'desks', footprintW: 2, isDesk: true }),
    asset('WHITEBOARD', { category: 'wall', footprintW: 2, canPlaceOnWalls: true }),
    asset('WHITEBOARD_DRAWN', { category: 'wall', footprintW: 2, canPlaceOnWalls: true }),
    asset('BOOKSHELF', { category: 'wall', canPlaceOnWalls: true }),
    asset('PLANT_STAGE_1'),
    asset('PLANT_STAGE_2'),
    asset('PLANT_STAGE_3'),
    asset('FISH_TANK_OFF', { ...fish, state: 'off' }),
    asset('FISH_TANK_ON_1', { ...fish, state: 'on', animationGroup: 'FISH_ON', frame: 0 }),
    asset('FISH_TANK_ON_2', { ...fish, state: 'on', animationGroup: 'FISH_ON', frame: 1 }),
    asset('PRINTER_OFF', { ...printer, state: 'off' }),
    asset('PRINTER_ON_1', { ...printer, state: 'on', animationGroup: 'PRINTER_ON', frame: 0 }),
    asset('PRINTER_ON_2', { ...printer, state: 'on', animationGroup: 'PRINTER_ON', frame: 1 }),
    asset('PIZZA_BOX', { canPlaceOnSurfaces: true }),
    asset('PIZZA_BOX_OPEN', { canPlaceOnSurfaces: true }),
    asset('DIYA_ON_1', { canPlaceOnSurfaces: true, animationGroup: 'DIYA_ON', frame: 0 }),
    asset('DIYA_ON_2', { canPlaceOnSurfaces: true, animationGroup: 'DIYA_ON', frame: 1 }),
  ];
  const sprites: Record<string, string[][]> = {};
  for (const a of assets) sprites[a.id] = [['']];
  expect(buildDynamicCatalog({ catalog: assets, sprites })).toBe(true);
}

beforeAll(installFunCatalog);

/**
 * OFFICE_MAP (20×10) with: a desk in front of chair d1 (it faces up at it), a
 * whiteboard and a bookshelf on the Dev top wall, a plant, a printer, a fish
 * tank in the Lounge, and a table below the Cafe chairs.
 */
const FUN_FURNITURE: PlacedFurniture[] = [
  { uid: 'desk', type: 'TEST_DESK', col: 1, row: 1 },
  chair('d1', 2, 2),
  chair('d2', 4, 2),
  chair('d3', 6, 2),
  { uid: 'ashtray', type: 'ASHTRAY_STAND', col: 11, row: 2 },
  { uid: 'board', type: 'WHITEBOARD', col: 6, row: 0 },
  { uid: 'shelf', type: 'BOOKSHELF', col: 8, row: 0 },
  { uid: 'plant', type: 'PLANT_STAGE_1', col: 9, row: 4 },
  { uid: 'printer', type: 'PRINTER_OFF', col: 8, row: 4 },
  { uid: 'fish', type: 'FISH_TANK_OFF', col: 1, row: 8 },
  chair('l1', 2, 6),
  chair('l2', 3, 6),
  chair('m0', 6, 5),
  chair('m1', 7, 6),
  chair('m2', 8, 6),
  chair('c1', 11, 6),
  chair('c2', 12, 6),
  { uid: 'table', type: 'TEST_TABLE', col: 11, row: 7 },
];

function funOffice(start: Date): { os: OfficeState; clock: { ms: number } } {
  const os = new OfficeState(layoutFrom(OFFICE_MAP, FUN_FURNITURE));
  const clock = { ms: start.getTime() };
  os.nowMs = () => clock.ms;
  os.zoneRandom = () => 0.99; // no chance-driven pastimes unless a test wants one
  return { os, clock };
}

function tick(os: OfficeState, clock: { ms: number }, seconds: number, dt = 0.05): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    clock.ms += dt * 1000;
    os.update(dt);
  }
}

function agentAt(os: OfficeState, id: number, seat: string, active: boolean): Character {
  os.addAgent(id, 0, 0, seat, true);
  if (!active) os.setAgentActive(id, false);
  return os.characters.get(id)!;
}

const types = (os: OfficeState) => os.fun.decorate(os.getLayout().furniture).map((f) => f.type);

describe('the director: rituals', () => {
  it('10:00 standup: idle agents sit in the Meeting room for 30 s, then go back', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 10, 0, 1));
    const a = agentAt(os, 1, 'd1', false);
    const b = agentAt(os, 2, 'd2', false);
    tick(os, clock, 15);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    expect(b.zoneTarget?.zone).toBe(ZoneLabel.MEETING);
    expect(a.zoneTarget?.key).not.toBe(b.zoneTarget?.key);
    expect(os.fun.borrows.get(1)?.kind).toBe('standup');
    tick(os, clock, 40);
    expect(os.fun.borrows.size).toBe(0);
    tick(os, clock, 20);
    expect(a.zoneTarget?.zone).toBe(ZoneLabel.SMOKE); // waiting again: back to the terrace
  });

  it('no standup when nobody is idle, and none outside 10:00', () => {
    const busy = funOffice(local(2026, 10, 19, 10, 0, 1));
    agentAt(busy.os, 1, 'd1', true);
    tick(busy.os, busy.clock, 5);
    expect(busy.os.fun.borrows.size).toBe(0);

    const late = funOffice(local(2026, 10, 19, 11, 0));
    const c = agentAt(late.os, 1, 'd1', false);
    tick(late.os, late.clock, 15);
    expect(c.zoneTarget?.zone).toBe(ZoneLabel.SMOKE);
  });

  it('19:00 banner with today’s totals', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 19, 0, 2));
    os.fun.onMessage({
      type: 'dailyStats',
      date: '2026-10-19',
      prs: [
        { title: 'a', repo: 'r', at: 1 },
        { title: 'b', repo: 'r', at: 2 },
      ],
      pushes: [{ repo: 'r', count: 4 }],
      filesEdited: 0,
      commandsRun: 0,
      activeMs: 0,
    });
    tick(os, clock, 1);
    expect(os.fun.banner?.text).toBe('Today: 2 PRs · 4 pushes 🎉');
    tick(os, clock, 61);
    expect(os.fun.banner).toBeNull();
  });
});

describe('the director: whiteboard and library', () => {
  it('plan mode: draws at the whiteboard (WHITEBOARD → WHITEBOARD_DRAWN), back to the desk after', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    const ch = agentAt(os, 1, 'd1', true);
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 't1',
      status: 'Planning',
      toolName: 'EnterPlanMode',
    });
    tick(os, clock, 10);
    expect(ch.zoneTarget?.zone).toBe('Whiteboard');
    expect([ch.tileCol, ch.tileRow]).toEqual([6, 1]);
    expect(types(os)).toContain('WHITEBOARD_DRAWN');
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 't2',
      status: 'Using ExitPlanMode',
      toolName: 'ExitPlanMode',
    });
    tick(os, clock, 1);
    expect(ch.zoneTarget ?? null).toBeNull();
    expect(types(os)).not.toContain('WHITEBOARD_DRAWN');
  });

  it('a live web search: reads at the nearest bookshelf, lingers, then goes back', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    const ch = agentAt(os, 1, 'd1', true);
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 'w',
      status: 'Searching the web',
      toolName: 'WebSearch',
    });
    tick(os, clock, 10);
    expect(ch.zoneTarget?.zone).toBe('Library');
    expect([ch.tileCol, ch.tileRow]).toEqual([8, 1]);
    os.fun.onMessage({ type: 'agentToolDone', id: 1, toolId: 'w' });
    tick(os, clock, 4);
    expect(ch.zoneTarget?.zone).toBe('Library'); // no pacing on a short search
    tick(os, clock, 6);
    expect(ch.zoneTarget ?? null).toBeNull();
  });

  it('a permission request wins over the whiteboard', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    agentAt(os, 1, 'd1', true);
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 't1',
      status: 'Planning',
      toolName: 'EnterPlanMode',
    });
    tick(os, clock, 3);
    expect(os.fun.borrows.get(1)?.kind).toBe('whiteboard');
    os.fun.onMessage({ type: 'agentToolPermission', id: 1 });
    tick(os, clock, 1);
    expect(os.fun.borrows.has(1)).toBe(false);
  });
});

describe('the director: furniture', () => {
  it('plants grow with this week’s PRs', () => {
    const { os, clock } = funOffice(local(2026, 10, 21, 14)); // a Wednesday
    expect(types(os)).toContain('PLANT_STAGE_1');
    const days = [
      { date: '2026-10-18', prs: 9, pushes: 0, activeMs: 0 }, // last week
      { date: '2026-10-19', prs: 2, pushes: 0, activeMs: 0 },
      { date: '2026-10-21', prs: 2, pushes: 0, activeMs: 0 },
    ];
    os.fun.onMessage({ type: 'weekStats', days });
    tick(os, clock, 0.1);
    expect(types(os)).toContain('PLANT_STAGE_2');
    os.fun.onMessage({
      type: 'weekStats',
      days: [...days, { date: '2026-10-20', prs: 3, pushes: 0, activeMs: 0 }],
    });
    expect(types(os)).toContain('PLANT_STAGE_3');
  });

  it('pizza on the Cafe table after 3 PRs today, gone the next day', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    const stats = (date: string, n: number) => ({
      type: 'dailyStats',
      date,
      prs: Array.from({ length: n }, (_, i) => ({ title: `p${i}`, repo: 'r', at: i })),
      pushes: [],
      filesEdited: 0,
      commandsRun: 0,
      activeMs: 0,
    });
    os.fun.onMessage(stats('2026-10-19', 2));
    tick(os, clock, 31);
    expect(types(os)).not.toContain('PIZZA_BOX_OPEN');
    os.fun.onMessage(stats('2026-10-19', 3));
    tick(os, clock, 31);
    const placed = os.fun.decorate(os.getLayout().furniture);
    expect(placed.find((f) => f.type === 'PIZZA_BOX_OPEN')).toMatchObject({ col: 11, row: 7 });
    expect(placed.find((f) => f.type === 'PIZZA_BOX')).toMatchObject({ col: 12, row: 7 });
    clock.ms = local(2026, 10, 20, 0, 1).getTime(); // past midnight
    tick(os, clock, 31);
    expect(types(os)).not.toContain('PIZZA_BOX_OPEN');
  });

  it('the printer prints for ~3 s on a .md Write; the fish tank always swims', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    agentAt(os, 1, 'd1', true);
    expect(types(os)).toContain('PRINTER_OFF');
    expect(types(os).some((t) => t.startsWith('FISH_TANK_ON'))).toBe(true);
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 'w',
      status: 'Writing notes.md',
      toolName: 'Write',
    });
    tick(os, clock, 0.5);
    expect(types(os).some((t) => t.startsWith('PRINTER_ON'))).toBe(true);
    tick(os, clock, 3);
    expect(types(os)).toContain('PRINTER_OFF');
    os.fun.onMessage({
      type: 'agentToolStart',
      id: 1,
      toolId: 'x',
      status: 'Writing app.ts',
      toolName: 'Write',
    });
    tick(os, clock, 0.5);
    expect(types(os)).toContain('PRINTER_OFF');
  });

  it('Diwali puts diyas on free desk tiles (runtime only, never in the layout)', () => {
    const { os, clock } = funOffice(local(2026, 11, 8, 14));
    tick(os, clock, 0.1);
    expect(types(os).some((t) => t.startsWith('DIYA'))).toBe(true);
    expect(os.getLayout().furniture.some((f) => f.type.startsWith('DIYA'))).toBe(false);
    os.fun.forceFestival(null);
    tick(os, clock, 0.1);
    expect(types(os).some((t) => t.startsWith('DIYA'))).toBe(false);
  });
});

describe('the director: smart pets', () => {
  it('Gitcat sits on the busiest agent’s desk, beside its line of sight', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    agentAt(os, 1, 'd1', true);
    const cat = createPet('cat', 0, 15, 6);
    cat.name = 'Gitcat';
    os.pets.push(cat);
    for (let i = 0; i < 5; i++) {
      os.fun.onMessage({
        type: 'agentToolStart',
        id: 1,
        toolId: `t${i}`,
        status: 'Reading a.ts',
        toolName: 'Read',
      });
    }
    tick(os, clock, 20);
    // On the desk (row 1) one column beside the agent's chair (col 2), at the desk's front edge.
    expect(cat.x).toBe(3 * 16 + 8);
    expect(cat.y).toBe(2 * 16 - 4);
  });

  it('Claudio waits just inside the Entrance door for a newcomer', () => {
    const { os, clock } = funOffice(local(2026, 10, 19, 14));
    const dog = createPet('dog', 0, 15, 6);
    dog.name = 'Claudio';
    os.pets.push(dog);
    os.fun.onMessage({ type: 'agentCreated', id: 7 });
    tick(os, clock, 5);
    // The door is (19,7), opening west: two tiles in.
    expect([dog.tileCol, dog.tileRow]).toEqual([17, 7]);
    tick(os, clock, 10);
    expect(os.fun.petGoal(dog)).toEqual({ kind: 'roam' });
  });
});
