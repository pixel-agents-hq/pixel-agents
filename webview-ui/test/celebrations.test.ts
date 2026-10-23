/**
 * Living office phase B — celebrations (docs/office/DESIGN.md "B. Celebrations"):
 * what's new in a dailyStats (PRs deduped by url / title+time, push counts per
 * repo), who shipped it (ship command → repo → most recently active), the
 * trophy wall's shelves and slots, the confetti physics and the bell, and the
 * OfficeState wiring (runtime-only trophies after their shelf, the bell's
 * life, no replay on reload).
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { DailyPr, DailyStats } from '../../core/src/messages.js';
import {
  BELL_SHOW_SEC,
  BELL_WOBBLE_PX,
  BELL_WOBBLE_SEC,
  CONFETTI_GRAVITY,
  CONFETTI_LIFE_SEC,
  CONFETTI_PARTICLE_COUNT,
  CONFETTI_TERMINAL_VY,
  SHIP_ATTRIBUTION_WINDOW_MS,
  TROPHY_BOX_TYPE,
} from '../src/constants.js';
import type { ConfettiParticle } from '../src/office/engine/celebrations.js';
import {
  bellSpot,
  bellWobble,
  deskIndex,
  particleAlpha,
  spawnConfetti,
  stepConfetti,
  stepParticle,
} from '../src/office/engine/celebrations.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { ShipEvent, ShipSignal } from '../src/office/engine/shipEvents.js';
import {
  attributeShip,
  classifyShipCommand,
  newShipEvents,
  noteShipTool,
  sameRepo,
  tallyOf,
} from '../src/office/engine/shipEvents.js';
import {
  TROPHY_UID_PREFIX,
  trophyShelves,
  trophyTypes,
  withTrophies,
} from '../src/office/engine/trophyWall.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import type { PlacedFurniture, Seat, SpriteData } from '../src/office/types.js';
import { Direction, TILE_SIZE } from '../src/office/types.js';
import { layoutFrom } from './livingOfficeFixture.js';

// ── Fixtures ──────────────────────────────────────────────────────

const DAY = '2026-10-18';

function stats(
  prs: DailyPr[] = [],
  pushes: Array<{ repo: string; count: number }> = [],
  date = DAY,
): DailyStats {
  return { type: 'dailyStats', date, prs, pushes, filesEdited: 0, commandsRun: 0, activeMs: 0 };
}

const pr = (title: string, at: number, url?: string, repo = 'pixel-agents'): DailyPr => ({
  title,
  repo,
  at,
  ...(url ? { url } : {}),
});

const blank = (w: number, h: number): SpriteData =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => ''));

type CatalogAsset = LoadedAssetData['catalog'][number];
const asset = (id: string, w: number, h: number, over: Partial<CatalogAsset> = {}) => ({
  asset: {
    id,
    label: id,
    category: 'misc',
    width: w * TILE_SIZE,
    height: h * TILE_SIZE,
    footprintW: w,
    footprintH: h,
    isDesk: false,
    ...over,
  } as CatalogAsset,
  sprite: blank(w * TILE_SIZE, h * TILE_SIZE),
});

/** Chair, desk, bookshelf, the trophies and the bell (office-pack sizes). */
function installCelebrationCatalog(): void {
  const items = [
    asset('CHAIR', 1, 1, { category: 'chairs' }),
    asset('DESK', 3, 1, { category: 'desks', isDesk: true }),
    // The bundled desk: 3×2, its top row a walk-behind background row.
    asset('DESK_FRONT', 3, 2, { category: 'desks', isDesk: true, backgroundTiles: 1 }),
    asset('PC', 1, 1, { category: 'electronics', canPlaceOnSurfaces: true }),
    asset('DOUBLE_BOOKSHELF', 2, 2, { category: 'wall', canPlaceOnWalls: true }),
    ...['TROPHY_CUP_GOLD', 'TROPHY_CUP_SILVER', 'TROPHY_CUP_BRONZE', 'TROPHY_BOX'].map((id) =>
      asset(id, 1, 2, { category: 'decor', canPlaceOnSurfaces: true, backgroundTiles: 1 }),
    ),
    asset('BELL', 1, 1, { canPlaceOnSurfaces: true }),
  ];
  const ok = buildDynamicCatalog({
    catalog: items.map((i) => i.asset),
    sprites: Object.fromEntries(items.map((i) => [i.asset.id, i.sprite])),
  });
  expect(ok).toBe(true);
}

/** Footprints for the pure trophy-wall functions. */
const footprint = (type: string) =>
  type === 'DOUBLE_BOOKSHELF' ? { w: 2, h: 2 } : type === 'DESK' ? { w: 3, h: 1 } : { w: 1, h: 1 };

// ── What's new in a dailyStats ────────────────────────────────────

describe('newShipEvents', () => {
  it('takes the first stats after a load as the baseline: nothing replays', () => {
    expect(newShipEvents(null, stats([pr('A', 1, 'u/1')], [{ repo: 'r', count: 3 }]))).toEqual([]);
  });

  it('reports a new PR once, deduped by url', () => {
    const before = tallyOf(stats([pr('A', 1, 'u/1')]));
    const next = stats([pr('A', 1, 'u/1'), pr('B', 2, 'u/2'), pr('B again', 3, 'u/2')]);
    const events = newShipEvents(before, next);
    expect(events).toEqual([{ kind: 'pr', repo: 'pixel-agents', title: 'B', count: 1 }]);
  });

  it('dedupes PRs without a url by title + time, and keeps a url filled in later as seen', () => {
    const before = tallyOf(stats([pr('A', 1)]));
    expect(newShipEvents(before, stats([pr('A', 1)]))).toEqual([]);
    expect(newShipEvents(before, stats([pr('A', 1, 'u/1')]))).toEqual([]);
    // Same title at another time is another PR.
    expect(newShipEvents(before, stats([pr('A', 1), pr('A', 9)]))).toHaveLength(1);
  });

  it('reports a push per repo whose count grew, with the increase', () => {
    const before = tallyOf(
      stats(
        [],
        [
          { repo: 'a', count: 2 },
          { repo: 'b', count: 1 },
        ],
      ),
    );
    const events = newShipEvents(
      before,
      stats(
        [],
        [
          { repo: 'a', count: 4 },
          { repo: 'b', count: 1 },
          { repo: 'c', count: 1 },
        ],
      ),
    );
    expect(events).toEqual([
      { kind: 'push', repo: 'a', count: 2 },
      { kind: 'push', repo: 'c', count: 1 },
    ]);
  });

  it('identical or shrinking stats are not news', () => {
    const s = stats([pr('A', 1, 'u/1')], [{ repo: 'a', count: 2 }]);
    expect(newShipEvents(tallyOf(s), s)).toEqual([]);
    expect(newShipEvents(tallyOf(s), stats([], [{ repo: 'a', count: 1 }]))).toEqual([]);
  });

  it('measures a new day against an empty one (midnight reset)', () => {
    const yesterday = tallyOf(stats([pr('A', 1, 'u/1')], [{ repo: 'a', count: 5 }], '2026-10-17'));
    expect(newShipEvents(yesterday, stats())).toEqual([]);
    const events = newShipEvents(yesterday, stats([pr('A', 1, 'u/1')], [{ repo: 'a', count: 1 }]));
    expect(events.map((e) => e.kind)).toEqual(['pr', 'push']);
  });

  it('tallies distinct PRs and total pushes', () => {
    const t = tallyOf(
      stats(
        [pr('A', 1, 'u/1'), pr('A', 1, 'u/1'), pr('B', 2)],
        [
          { repo: 'a', count: 2 },
          { repo: 'b', count: 3 },
        ],
      ),
    );
    expect(t.prCount).toBe(2);
    expect(t.pushCount).toBe(5);
  });
});

// ── Who shipped it ────────────────────────────────────────────────

describe('classifyShipCommand', () => {
  it('spots git push and gh pr create in a status line', () => {
    expect(classifyShipCommand('Running: git push -u origin feat/x')).toEqual({
      push: true,
      pr: false,
    });
    expect(classifyShipCommand('Running: git -C ../repo push')).toEqual({ push: true, pr: false });
    expect(classifyShipCommand('Running: gh pr create --title "x"')).toEqual({
      push: false,
      pr: true,
    });
    expect(classifyShipCommand('Running: git push && gh pr create --fill')).toEqual({
      push: true,
      pr: true,
    });
    expect(classifyShipCommand('Running: git status')).toEqual({ push: false, pr: false });
    expect(classifyShipCommand('Editing push.ts')).toEqual({ push: false, pr: false });
  });
});

describe('attributeShip', () => {
  const NOW = 1_000_000_000;
  const push: ShipEvent = { kind: 'push', repo: 'pixel-agents', count: 1 };
  const prEvent: ShipEvent = { kind: 'pr', repo: 'owner/pixel-agents', title: 'x', count: 1 };
  const signal = (status: string, at: number, lastToolAt = at): ShipSignal => ({
    ...noteShipTool(undefined, status, at),
    lastToolAt,
  });

  it('credits the agent whose latest ship command matches, most recent first', () => {
    const signals = new Map<number, ShipSignal>([
      [1, signal('Running: git push', NOW - 5000)],
      [2, signal('Running: git push', NOW - 1000)],
      [3, signal('Running: npm test', NOW - 10)],
    ]);
    expect(attributeShip(push, [{ id: 1 }, { id: 2 }, { id: 3 }], signals, NOW)).toBe(2);
  });

  it('prefers a ship command in the same repo, and matches owner/repo PR repos', () => {
    const signals = new Map<number, ShipSignal>([
      [1, signal('Running: gh pr create --fill', NOW - 5000)],
      [2, signal('Running: gh pr create --fill', NOW - 1000)],
    ]);
    const candidates = [
      { id: 1, repo: 'pixel-agents' },
      { id: 2, repo: 'hobbyfi-blog' },
    ];
    expect(attributeShip(prEvent, candidates, signals, NOW)).toBe(1);
  });

  it('a ship command of the other kind or outside the window does not count', () => {
    const signals = new Map<number, ShipSignal>([
      [1, signal('Running: gh pr create', NOW - 1000)], // a PR, not a push
      [2, signal('Running: git push', NOW - SHIP_ATTRIBUTION_WINDOW_MS - 1, NOW - 100)],
      [3, signal('Running: ls', NOW - 50)],
    ]);
    // No match: falls back to the most recently active agent.
    expect(attributeShip(push, [{ id: 1 }, { id: 2 }, { id: 3 }], signals, NOW)).toBe(3);
  });

  it('keeps the last ship command across later tools', () => {
    let s = noteShipTool(undefined, 'Running: git push', NOW - 3000);
    s = noteShipTool(s, 'Running: git status', NOW - 1000);
    expect(s.ship?.push).toBe(true);
    expect(s.lastToolAt).toBe(NOW - 1000);
    const signals = new Map<number, ShipSignal>([
      [1, s],
      [2, signal('Reading a.ts', NOW)],
    ]);
    expect(attributeShip(push, [{ id: 1 }, { id: 2 }], signals, NOW)).toBe(1);
  });

  it('falls back to the most recently active agent in that repo, then anyone active', () => {
    const signals = new Map<number, ShipSignal>([
      [1, signal('Reading a.ts', NOW - 9000)],
      [2, signal('Reading b.ts', NOW - 10)],
    ]);
    expect(
      attributeShip(
        push,
        [
          { id: 1, repo: 'pixel-agents' },
          { id: 2, repo: 'other' },
        ],
        signals,
        NOW,
      ),
    ).toBe(1);
    expect(attributeShip(push, [{ id: 1 }, { id: 2 }], signals, NOW)).toBe(2);
  });

  it('credits nobody when no agent has done anything', () => {
    expect(attributeShip(push, [{ id: 1 }], new Map(), NOW)).toBeNull();
    expect(attributeShip(push, [], new Map(), NOW)).toBeNull();
  });

  it('sameRepo compares bare repo names, case-insensitively', () => {
    expect(sameRepo('Owner/Pixel-Agents', 'pixel-agents')).toBe(true);
    expect(sameRepo('a', undefined)).toBe(false);
    expect(sameRepo('a', 'b')).toBe(false);
  });
});

// ── The trophy wall ───────────────────────────────────────────────

describe('trophy wall', () => {
  // Wall on row 0-1 (the shelves hang there); Lounge floor below the right
  // half, Dev below the left.
  const MAP = ['WWWWWWWWWWWW', 'WWWWWWWWWWWW', 'DDDDDDLLLLLL', 'DDDDDDLLLLLL'];
  const shelf = (uid: string, col: number): PlacedFurniture => ({
    uid,
    type: 'DOUBLE_BOOKSHELF',
    col,
    row: 0,
  });
  const FURNITURE = [shelf('s-right', 10), shelf('s-dev', 1), shelf('s-left', 6), shelf('s8', 8)];

  it('shelves are the bookshelves over the Lounge, sorted by column', () => {
    const shelves = trophyShelves(layoutFrom(MAP, FURNITURE), footprint);
    expect(shelves.map((s) => s.uid)).toEqual(['s-left', 's8', 's-right']);
  });

  it('every bookshelf is a shelf when the layout has no Lounge', () => {
    const shelves = trophyShelves(layoutFrom(MAP, FURNITURE, { withAreas: false }), footprint);
    expect(shelves.map((s) => s.uid)).toEqual(['s-dev', 's-left', 's8', 's-right']);
  });

  it('cups for PRs (gold, silver, bronze, cycling), then a box per push, capped by slots', () => {
    expect(trophyTypes(4, 2, 10)).toEqual([
      'TROPHY_CUP_GOLD',
      'TROPHY_CUP_SILVER',
      'TROPHY_CUP_BRONZE',
      'TROPHY_CUP_GOLD',
      TROPHY_BOX_TYPE,
      TROPHY_BOX_TYPE,
    ]);
    expect(trophyTypes(1, 5, 3)).toEqual(['TROPHY_CUP_GOLD', TROPHY_BOX_TYPE, TROPHY_BOX_TYPE]);
    expect(trophyTypes(0, 0, 3)).toEqual([]);
    expect(trophyTypes(2, 2, 0)).toEqual([]);
  });

  it('puts each trophy right after its shelf, in the shelf gap, without touching the input', () => {
    const layout = layoutFrom(MAP, FURNITURE);
    const out = withTrophies(layout, footprint, 1, 1);
    expect(out.map((f) => f.uid)).toEqual([
      's-right',
      's-dev',
      's-left',
      `${TROPHY_UID_PREFIX}s-left`,
      's8',
      `${TROPHY_UID_PREFIX}s8`,
    ]);
    expect(out[3]).toMatchObject({ type: 'TROPHY_CUP_GOLD', col: 7, row: 0 });
    expect(out[5]).toMatchObject({ type: TROPHY_BOX_TYPE, col: 9, row: 0 });
    expect(layout.furniture).toHaveLength(4);
    expect(withTrophies(layout, footprint, 0, 0)).toBe(layout.furniture);
  });
});

// ── Confetti and the bell ─────────────────────────────────────────

/** A deterministic [0, 1) sequence. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('confetti', () => {
  it('bursts CONFETTI_PARTICLE_COUNT flakes upward from the origin', () => {
    const burst = spawnConfetti(100, 50, seeded());
    expect(burst.particles).toHaveLength(CONFETTI_PARTICLE_COUNT);
    for (const p of burst.particles) {
      expect(p.x).toBe(100);
      expect(p.y).toBe(50);
      expect(p.vy).toBeLessThan(0);
      expect(p.life).toBeLessThanOrEqual(CONFETTI_LIFE_SEC);
    }
    // Several colours, not one.
    expect(new Set(burst.particles.map((p) => p.color)).size).toBeGreaterThan(3);
  });

  it('gravity pulls a flake down to a paper-like fall, and drag slows it sideways', () => {
    const p: ConfettiParticle = {
      x: 0,
      y: 0,
      vx: 30,
      vy: -60,
      age: 0,
      life: CONFETTI_LIFE_SEC,
      color: 0,
      phase: 0,
    };
    stepParticle(p, 0.1);
    expect(p.vy).toBeCloseTo(-60 + CONFETTI_GRAVITY * 0.1);
    expect(p.y).toBeLessThan(0); // still rising
    expect(Math.abs(p.vx)).toBeLessThan(30);
    expect(p.x).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) stepParticle(p, 0.1);
    expect(p.vy).toBe(CONFETTI_TERMINAL_VY);
    expect(p.y).toBeGreaterThan(0); // fell back past the origin
  });

  it('fades out at the end of its life', () => {
    const p = spawnConfetti(0, 0, seeded()).particles[0];
    expect(particleAlpha(p)).toBe(1);
    p.age = p.life - 0.0001;
    expect(particleAlpha(p)).toBeGreaterThan(0);
    expect(particleAlpha(p)).toBeLessThan(0.01);
    p.age = p.life;
    expect(particleAlpha(p)).toBe(0);
  });

  it('a burst is over after CONFETTI_LIFE_SEC', () => {
    const burst = spawnConfetti(0, 0, seeded());
    let alive = true;
    let t = 0;
    while (alive && t < 10) {
      alive = stepConfetti(burst, 0.05);
      t += 0.05;
    }
    expect(alive).toBe(false);
    expect(t).toBeLessThanOrEqual(CONFETTI_LIFE_SEC + 0.06);
    expect(t).toBeGreaterThan(CONFETTI_LIFE_SEC * 0.79);
  });
});

describe('bell', () => {
  it('wobbles a whole pixel or two, then stands still', () => {
    const swings = Array.from({ length: 30 }, (_, i) => bellWobble(i * 0.02));
    expect(swings.some((x) => x !== 0)).toBe(true);
    for (const x of swings) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Math.abs(x)).toBeLessThanOrEqual(Math.ceil(BELL_WOBBLE_PX));
    }
    expect(bellWobble(BELL_WOBBLE_SEC)).toBe(0);
    expect(bellWobble(BELL_SHOW_SEC - 0.1)).toBe(0);
  });

  it('stands on a free desk tile beside the monitor in front of the seat', () => {
    installCelebrationCatalog();
    // Desk (1..3, 1), a PC on (2, 1), the chair below it facing up at (2, 2).
    const furniture: PlacedFurniture[] = [
      { uid: 'desk', type: 'DESK', col: 1, row: 1 },
      { uid: 'pc', type: 'PC', col: 2, row: 1 },
    ];
    const desks = deskIndex(furniture, getCatalogEntry);
    const seat: Seat = {
      uid: 'c',
      seatCol: 2,
      seatRow: 2,
      facingDir: Direction.UP,
      assigned: true,
    };
    const spot = bellSpot(seat, desks);
    expect(spot).toMatchObject({ col: 3, row: 1 });
    // Over the desk, like any surface item.
    expect(spot.zY).toBeGreaterThan(1 * TILE_SIZE + TILE_SIZE);
    // No desk in front: the floor tile it faces.
    const lonely: Seat = { ...seat, seatCol: 8 };
    expect(bellSpot(lonely, desks)).toMatchObject({ col: 8, row: 1, zY: 2 * TILE_SIZE });
  });

  it('skips a desk’s background row for its top', () => {
    installCelebrationCatalog();
    // A 3×2 desk on (1..3, 1..2): row 1 is its background row, a PC on (2, 2).
    const furniture: PlacedFurniture[] = [
      { uid: 'desk', type: 'DESK_FRONT', col: 1, row: 1 },
      { uid: 'pc', type: 'PC', col: 2, row: 2 },
    ];
    const desks = deskIndex(furniture, getCatalogEntry);
    // The chair above it, facing down.
    const seat: Seat = {
      uid: 'c',
      seatCol: 2,
      seatRow: 0,
      facingDir: Direction.DOWN,
      assigned: true,
    };
    const spot = bellSpot(seat, desks);
    expect(spot).toMatchObject({ col: 3, row: 2 });
    expect(spot.zY).toBe(1 * TILE_SIZE + 2 * TILE_SIZE + 0.5);
  });
});

// ── OfficeState wiring ────────────────────────────────────────────

describe('OfficeState celebrations', () => {
  // Shelves hang on the wall (rows 0-1) over the Lounge; the desk room below.
  const MAP = [
    'WWWWWWWWWWWW',
    'WWWWWWWWWWWW',
    'LLLLLLLLLLLL',
    'DDDDDDDDDDDD',
    'DDDDDDDDDDDD',
    'DDDDDDDDDDDD',
  ];
  const FURNITURE: PlacedFurniture[] = [
    { uid: 'sh1', type: 'DOUBLE_BOOKSHELF', col: 4, row: 0 },
    { uid: 'sh0', type: 'DOUBLE_BOOKSHELF', col: 1, row: 0 },
    { uid: 'desk', type: 'DESK', col: 1, row: 3 },
    { uid: 'chair', type: 'CHAIR', col: 2, row: 4 },
  ];

  function office(): OfficeState {
    installCelebrationCatalog();
    const os = new OfficeState(layoutFrom(MAP, FURNITURE));
    os.celebrations.random = seeded();
    os.addAgent(1, 0, 0, 'chair', true, 'pixel-agents');
    os.addAgent(2, 1, 0, undefined, true, 'other');
    return os;
  }

  /** The furniture instances drawn with `type`'s sprite. */
  const sprites = (os: OfficeState, type: string) => {
    const sprite = getCatalogEntry(type)?.sprite;
    return os.furniture.filter((f) => f.sprite === sprite);
  };
  /** The draw order of the shelves and trophies. */
  const wallOrder = (os: OfficeState) => {
    const name = new Map(
      ['DOUBLE_BOOKSHELF', 'TROPHY_CUP_GOLD', TROPHY_BOX_TYPE].map((t) => [
        getCatalogEntry(t)?.sprite,
        t,
      ]),
    );
    return os.furniture.map((f) => name.get(f.sprite)).filter((t) => t !== undefined);
  };

  it('shows the day on the shelves from the first stats, without celebrating it', () => {
    const os = office();
    const n = os.celebrate(stats([pr('A', 1, 'u/1')], [{ repo: 'pixel-agents', count: 1 }]));
    expect(n).toBe(0);
    expect(os.celebrations.bells).toHaveLength(0);
    expect(os.celebrations.bursts).toHaveLength(0);
    // Gold cup on the leftmost shelf, a box on the next — each right after its shelf.
    expect(wallOrder(os)).toEqual([
      'DOUBLE_BOOKSHELF',
      TROPHY_BOX_TYPE,
      'DOUBLE_BOOKSHELF',
      'TROPHY_CUP_GOLD',
    ]);
    expect(sprites(os, 'TROPHY_CUP_GOLD')[0]).toMatchObject({ x: 2 * TILE_SIZE, y: 0 });
    expect(sprites(os, TROPHY_BOX_TYPE)[0]).toMatchObject({ x: 5 * TILE_SIZE, y: 0 });
    // Runtime-only: the layout (what gets saved) has no trophies.
    expect(os.getLayout().furniture.map((f) => f.uid)).toEqual(FURNITURE.map((f) => f.uid));
  });

  it('a new push rings the bell on the shipper’s desk and throws confetti over them', () => {
    const os = office();
    os.celebrate(stats());
    os.celebrations.noteTool(2, 'Reading notes.md', os.nowMs());
    os.celebrations.noteTool(1, 'Running: git push origin main', os.nowMs());
    expect(os.celebrate(stats([], [{ repo: 'pixel-agents', count: 1 }]))).toBe(1);
    expect(os.celebrations.bells.map((b) => b.agentId)).toEqual([1]);
    expect(os.celebrations.bursts).toHaveLength(1);
    const bell = sprites(os, 'BELL');
    expect(bell).toHaveLength(1);
    expect(bell[0].y).toBe(3 * TILE_SIZE); // on the desk row, in front of the chair
    expect(sprites(os, TROPHY_BOX_TYPE)).toHaveLength(1);

    // The bell goes after BELL_SHOW_SEC; the confetti after its life.
    for (let t = 0; t < BELL_SHOW_SEC + 0.1; t += 0.05) os.update(0.05);
    expect(sprites(os, 'BELL')).toHaveLength(0);
    for (let t = 0; t < CONFETTI_LIFE_SEC; t += 0.05) os.update(0.05);
    expect(os.celebrations.bursts).toHaveLength(0);
    // The trophy stays.
    expect(sprites(os, TROPHY_BOX_TYPE)).toHaveLength(1);
  });

  it('trophies reset with the stats at midnight', () => {
    const os = office();
    os.celebrate(stats([pr('A', 1, 'u/1')], [], '2026-10-17'));
    expect(sprites(os, 'TROPHY_CUP_GOLD')).toHaveLength(1);
    expect(os.celebrate(stats())).toBe(0);
    expect(sprites(os, 'TROPHY_CUP_GOLD')).toHaveLength(0);
  });
});
