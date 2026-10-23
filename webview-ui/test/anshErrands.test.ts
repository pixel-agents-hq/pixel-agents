/**
 * Ansh's errands between thoughts (office/engine/anshErrands.ts and
 * OfficeState.anshWander): the human things he does when the office has the
 * furniture or the company for them — pet a pet, water a plant, make a
 * coffee, chat with the receptionist or the Manager, look out of a window —
 * each with a line in a bubble, and the old quiet wander when there is
 * nothing else.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  ANSH_COFFEE_CUP_SEC,
  ANSH_COFFEE_LINES,
  ANSH_ERRAND_LINE_SEC,
  ANSH_ERRAND_REPLY_AT_SEC,
  ANSH_ERRAND_STAY_SEC,
  ANSH_ERRAND_WEIGHTS,
  ANSH_MANAGER_EXCHANGES,
  ANSH_PET_LINES,
  ANSH_PLANT_LINES,
  ANSH_RECEPTION_EXCHANGES,
  ANSH_WATER_DROP_COLOR,
  ANSH_WATERING_DROP_PERIOD_SEC,
  ANSH_WINDOW_LINES,
} from '../src/constants.js';
import {
  AnshErrand,
  errandScript,
  faceToFaceSpot,
  furnitureErrand,
  linesShowing,
  pickErrand,
  scheduleLines,
  standSpotFor,
  tileBeside,
  wateringCanPixels,
} from '../src/office/engine/anshErrands.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { createPet } from '../src/office/engine/petEntity.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { Character, OfficeLayout, Pet, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, Direction, PetState, TileType } from '../src/office/types.js';
import { chair, run } from './livingOfficeFixture.js';

// ── The rules ─────────────────────────────────────────────────

describe('which furniture an errand is for', () => {
  it('plants, the coffee machine, windows, boards and the fish tank; nothing else', () => {
    expect(furnitureErrand('PLANT')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('PLANT_2')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('PLANT_STAGE_1')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('LARGE_PLANT')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('CACTUS')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('HANGING_PLANT')).toBe(AnshErrand.PLANT);
    expect(furnitureErrand('COFFEE_MACHINE')).toBe(AnshErrand.COFFEE);
    expect(furnitureErrand('WINDOW_DAY')).toBe(AnshErrand.WINDOW);
    expect(furnitureErrand('WHITEBOARD')).toBe(AnshErrand.BOARD);
    expect(furnitureErrand('NOTICE_BOARD')).toBe(AnshErrand.BOARD);
    expect(furnitureErrand('FISH_TANK_OFF')).toBe(AnshErrand.FISH);
    // A mug on a desk is not a coffee machine, an empty pot is not a plant.
    expect(furnitureErrand('COFFEE')).toBeNull();
    expect(furnitureErrand('POT')).toBeNull();
    expect(furnitureErrand('DESK_FRONT')).toBeNull();
  });
});

describe('where he stands', () => {
  const open = (tiles: string[]) => {
    const set = new Set(tiles);
    return (c: number, r: number) => set.has(`${c},${r}`);
  };

  it('in front of (below) an item, the middle column first, looking at its bottom edge', () => {
    const spot = standSpotFor({ col: 4, row: 2 }, { w: 3, h: 2 }, open(['4,4', '5,4', '6,4']));
    expect(spot).toEqual({ col: 5, row: 4, look: { col: 5, row: 3 } });
  });

  it('reaches past a counter below it', () => {
    const spot = standSpotFor({ col: 4, row: 2 }, { w: 1, h: 1 }, open(['4,5']));
    expect(spot).toEqual({ col: 4, row: 5, look: { col: 4, row: 2 } });
  });

  it('beside it, then above it, then nowhere', () => {
    expect(standSpotFor({ col: 4, row: 2 }, { w: 1, h: 1 }, open(['5,2']))).toEqual({
      col: 5,
      row: 2,
      look: { col: 4, row: 2 },
    });
    expect(standSpotFor({ col: 4, row: 2 }, { w: 1, h: 1 }, open(['4,1']))).toEqual({
      col: 4,
      row: 1,
      look: { col: 4, row: 2 },
    });
    expect(standSpotFor({ col: 4, row: 2 }, { w: 1, h: 1 }, open([]))).toBeNull();
  });

  it('face to face: across the desk in front of them', () => {
    const post = { col: 3, row: 2, facing: Direction.DOWN };
    expect(faceToFaceSpot(post, open(['3,4']))).toEqual({ col: 3, row: 4 });
    expect(faceToFaceSpot(post, open(['2,2']))).toBeNull();
  });

  it('beside someone: below first, then the sides, then above', () => {
    expect(tileBeside({ col: 3, row: 3 }, open(['3,4', '2,3']))).toEqual({ col: 3, row: 4 });
    expect(tileBeside({ col: 3, row: 3 }, open(['3,2', '4,3']))).toEqual({ col: 4, row: 3 });
    expect(tileBeside({ col: 3, row: 3 }, open([]))).toBeNull();
  });
});

describe('the pick', () => {
  const options = [
    { kind: AnshErrand.PET, targets: [] as string[] },
    { kind: AnshErrand.PLANT, targets: ['fern', 'cactus'] },
    { kind: AnshErrand.COFFEE, targets: ['machine'] },
  ];

  it('only kinds the office offers, by weight, then one of its targets', () => {
    const plant = ANSH_ERRAND_WEIGHTS.plant;
    const total = plant + ANSH_ERRAND_WEIGHTS.coffee;
    const at = (kindR: number, targetR: number) => {
      const seq = [kindR, targetR];
      return pickErrand(options, () => seq.shift() ?? 0);
    };
    expect(at(0, 0)).toEqual({ kind: AnshErrand.PLANT, target: 'fern' });
    expect(at(0, 0.99)).toEqual({ kind: AnshErrand.PLANT, target: 'cactus' });
    expect(at((plant + 0.01) / total, 0)).toEqual({ kind: AnshErrand.COFFEE, target: 'machine' });
  });

  it('never the same kind twice in a row while there is another', () => {
    expect(pickErrand(options, () => 0, AnshErrand.PLANT)?.kind).toBe(AnshErrand.COFFEE);
    const plantsOnly = [{ kind: AnshErrand.PLANT, targets: ['fern'] }];
    expect(pickErrand(plantsOnly, () => 0, AnshErrand.PLANT)?.kind).toBe(AnshErrand.PLANT);
  });

  it('nothing to do: null', () => {
    expect(pickErrand([{ kind: AnshErrand.PET, targets: [] }], () => 0)).toBeNull();
    expect(pickErrand([], () => 0)).toBeNull();
  });
});

describe('what gets said', () => {
  it('his line on arrival; a chat gets its answer a moment later', () => {
    const plant = errandScript(AnshErrand.PLANT, () => 0);
    expect(plant.lines).toEqual([{ who: 'ansh', atSec: 0, text: ANSH_PLANT_LINES[0] }]);
    expect(plant.staySec).toBe(ANSH_ERRAND_STAY_SEC.plant);

    const chat = errandScript(AnshErrand.RECEPTION, () => 0);
    expect(chat.lines).toEqual([
      { who: 'ansh', atSec: 0, text: ANSH_RECEPTION_EXCHANGES[0][0] },
      {
        who: 'receptionist',
        atSec: ANSH_ERRAND_REPLY_AT_SEC,
        text: ANSH_RECEPTION_EXCHANGES[0][1],
      },
    ]);
    // He stays until the answer has been heard.
    expect(chat.staySec).toBeGreaterThanOrEqual(ANSH_ERRAND_REPLY_AT_SEC + ANSH_ERRAND_LINE_SEC);
    expect(errandScript(AnshErrand.MANAGER, () => 0).lines[1]).toEqual({
      who: 'manager',
      atSec: ANSH_ERRAND_REPLY_AT_SEC,
      text: ANSH_MANAGER_EXCHANGES[0][1],
    });
  });

  it('the pet by name, the window by the time of day, the quiet ones say nothing', () => {
    const pet = errandScript(AnshErrand.PET, () => 0, { petName: 'Biscuit' });
    expect(pet.lines[0].text).toBe(ANSH_PET_LINES[0].replaceAll('{pet}', 'Biscuit'));
    expect(pet.lines[0].text).toContain('Biscuit');
    expect(errandScript(AnshErrand.WINDOW, () => 0, { timeOfDay: 'night' }).lines[0].text).toBe(
      ANSH_WINDOW_LINES.night[0],
    );
    expect(errandScript(AnshErrand.PLACE, () => 0).lines).toEqual([]);
    expect(errandScript(AnshErrand.STRETCH, () => 0).lines).toEqual([]);
  });

  it('lines on the clock: each shows ANSH_ERRAND_LINE_SEC, the latest per speaker', () => {
    const lines = scheduleLines(errandScript(AnshErrand.MANAGER, () => 0).lines, 100);
    expect(linesShowing(lines, 99.9)).toEqual([]);
    expect(linesShowing(lines, 100).map((l) => l.who)).toEqual(['ansh']);
    expect(linesShowing(lines, 100 + ANSH_ERRAND_REPLY_AT_SEC).map((l) => l.who)).toEqual([
      'ansh',
      'manager',
    ]);
    expect(linesShowing(lines, 100 + ANSH_ERRAND_LINE_SEC).map((l) => l.who)).toEqual(['manager']);
    expect(linesShowing(lines, 100 + ANSH_ERRAND_REPLY_AT_SEC + ANSH_ERRAND_LINE_SEC)).toEqual([]);
  });
});

describe('the watering can', () => {
  const drop = (px: ReturnType<typeof wateringCanPixels>) =>
    px.find((p) => p.color === ANSH_WATER_DROP_COLOR)!;

  it('a drop falls from the spout, then the next one', () => {
    const start = drop(wateringCanPixels(Direction.RIGHT, 0));
    const later = drop(wateringCanPixels(Direction.RIGHT, ANSH_WATERING_DROP_PERIOD_SEC * 0.7));
    const next = drop(wateringCanPixels(Direction.RIGHT, ANSH_WATERING_DROP_PERIOD_SEC));
    expect(later.dy).toBeGreaterThan(start.dy);
    expect(later.dx).toBe(start.dx);
    expect(next).toEqual(start);
  });

  it('poured toward the plant: mirrored when he faces left', () => {
    expect(drop(wateringCanPixels(Direction.RIGHT, 0)).dx).toBeGreaterThan(0);
    expect(drop(wateringCanPixels(Direction.LEFT, 0)).dx).toBeLessThan(0);
  });
});

// ── In the office ─────────────────────────────────────────────

beforeAll(() => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({
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
  const ids = ['CHAIR', 'DESK', 'PLANT', 'COFFEE_MACHINE', 'RECEPTION_DESK', 'WINDOW_DAY'];
  const ok = buildDynamicCatalog({
    catalog: [
      item('CHAIR', { category: 'chairs' }),
      item('DESK', {
        category: 'desks',
        width: 48,
        height: 32,
        footprintW: 3,
        footprintH: 2,
        isDesk: true,
        backgroundTiles: 1,
      }),
      item('PLANT', { category: 'decor' }),
      item('COFFEE_MACHINE', { category: 'electronics' }),
      item('RECEPTION_DESK', { category: 'desks', isDesk: true, width: 32, footprintW: 2 }),
      item('WINDOW_DAY', { category: 'wall', canPlaceOnWalls: true }),
    ],
    sprites: Object.fromEntries(ids.map((id) => [id, [['']]])),
  });
  expect(ok).toBe(true);
});

const LABELS: Record<string, string> = {
  D: 'Dev',
  M: 'Meeting',
  E: 'Entrance',
  A: 'Ansh',
  G: 'Manager',
};

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
 * Ansh's walled room on the left (his chair (3,3) faces a desk), its doorway
 * at (6,4)-(6,5); the Manager's chair (9,4) in its Area outside; Dev floor to
 * the right and an Entrance bottom-right.
 */
const MAP = [
  'WWWWWWWWWWWWWWWW',
  'WWWWWWWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAAWDDDDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAA.DDGDDDDDW',
  'WAAAAAWDDDDDEEEW',
  'WAAAAAWDMMMMEEEE',
  'WWWWWWWDMMMMEEEW',
  'WWWWWWWWWWWWWWWW',
];

const BASE: PlacedFurniture[] = [
  chair('d1', 11, 2),
  chair('m1', 9, 8),
  chair('ansh', 3, 3),
  { uid: 'ansh-desk', type: 'DESK', col: 2, row: 4 },
  chair('mgr', 9, 4),
];

const office = (extra: PlacedFurniture[] = []) => {
  const os = new OfficeState(layoutFrom(MAP, [...BASE, ...extra]));
  os.ambienceNow = () => new Date(2026, 9, 19, 12, 0); // midday
  return os;
};
const at = (ch: { tileCol: number; tileRow: number }) => [ch.tileCol, ch.tileRow];

/** Run until Ansh stands still at the end of his walk out (fails after 30 s). */
function untilArrived(os: OfficeState): Character {
  const a = os.npcs.ansh!;
  let t = 0;
  while (!(os.npcs.anshOut && a.state === CharacterState.IDLE && a.path.length === 0)) {
    run(os, 0.1);
    t += 0.1;
    expect(t).toBeLessThan(30);
  }
  return a;
}

/** Run until he is back at his desk (fails after 40 s). */
function untilHome(os: OfficeState): void {
  let t = 0;
  while (os.npcs.anshOut) {
    run(os, 0.1);
    t += 0.1;
    expect(t).toBeLessThan(40);
  }
  expect(at(os.npcs.ansh!)).toEqual([3, 3]);
}

const saying = (os: OfficeState) =>
  Object.fromEntries(os.npcLinesShowing().map((l) => [l.who, l.text]));

function addPet(os: OfficeState, col: number, row: number): Pet {
  const pet = createPet('biscuit', 0, col, row);
  pet.name = 'Biscuit';
  os.pets.push(pet);
  return pet;
}

describe('Ansh’s errands', () => {
  it('waters a plant: stands in front of it, says his line, pours, walks back', () => {
    const os = office([{ uid: 'fern', type: 'PLANT', col: 12, row: 5 }]);
    expect(os.anshWander(() => 0)).toBe(true);
    const a = untilArrived(os);
    expect(at(a)).toEqual([12, 6]);
    expect(a.dir).toBe(Direction.UP);
    expect(saying(os)).toEqual({ ansh: ANSH_PLANT_LINES[0] });
    run(os, 1);
    expect(a.wateringCan).toBeGreaterThan(0);
    untilHome(os);
    expect(a.wateringCan).toBeUndefined();
    expect(saying(os)).toEqual({});
  });

  it('makes a coffee and carries the cup back', () => {
    const os = office([{ uid: 'cm', type: 'COFFEE_MACHINE', col: 12, row: 1 }]);
    expect(os.anshWander(() => 0)).toBe(true);
    const a = untilArrived(os);
    expect(at(a)).toEqual([12, 2]);
    expect(saying(os)).toEqual({ ansh: ANSH_COFFEE_LINES[0] });
    expect(a.carryingCup).toBeFalsy(); // not before it's made
    untilHome(os);
    expect(a.carryingCup).toBe(true); // at his desk, cup in hand
    run(os, ANSH_COFFEE_CUP_SEC);
    expect(a.carryingCup).toBeFalsy();
  });

  it('pets a pet: it sits still for him, faces him and shows a heart', () => {
    const os = office();
    const pet = addPet(os, 12, 3);
    expect(os.anshWander(() => 0)).toBe(true);
    const a = untilArrived(os);
    // The pet waited where it was; he is right next to it.
    expect(at(pet)).toEqual([12, 3]);
    expect(Math.abs(a.tileCol - 12) + Math.abs(a.tileRow - 3)).toBe(1);
    expect(pet.state).toBe(PetState.IDLE);
    expect(pet.bubbleType).toBe('heart');
    expect(saying(os).ansh).toContain('Biscuit');
    untilHome(os);
  });

  it('chats with the receptionist across her desk: both face each other, a line each', () => {
    const os = office([
      { uid: 'rdesk', type: 'RECEPTION_DESK', col: 12, row: 7 },
      chair('rchair', 12, 6),
    ]);
    const r = os.receptionist!;
    expect(r).not.toBeNull();
    expect(at(r)).toEqual([12, 6]);
    expect(os.anshWander(() => 0)).toBe(true);
    const a = untilArrived(os);
    expect(at(a)).toEqual([12, 8]);
    expect(a.dir).toBe(Direction.UP);
    expect(r.dir).toBe(Direction.DOWN);
    expect(saying(os)).toEqual({ ansh: ANSH_RECEPTION_EXCHANGES[0][0] });
    run(os, ANSH_ERRAND_REPLY_AT_SEC + 0.2);
    expect(saying(os).receptionist).toBe(ANSH_RECEPTION_EXCHANGES[0][1]);
    untilHome(os);
  });

  it('chats with the Manager, who turns to him and turns back after', () => {
    const os = office();
    const m = os.npcs.manager!;
    const before = m.dir;
    expect(os.anshWander(() => 0)).toBe(true); // nothing else on offer but the quiet ones
    const a = untilArrived(os);
    expect(Math.abs(a.tileCol - m.tileCol) + Math.abs(a.tileRow - m.tileRow)).toBe(1);
    run(os, ANSH_ERRAND_REPLY_AT_SEC + 0.2);
    expect(saying(os)).toEqual({
      ansh: ANSH_MANAGER_EXCHANGES[0][0],
      manager: ANSH_MANAGER_EXCHANGES[0][1],
    });
    untilHome(os);
    expect(m.dir).toBe(before);
  });

  it('looks out of a window on the wall, with a line for the time of day', () => {
    const os = office([{ uid: 'win', type: 'WINDOW_DAY', col: 12, row: 0 }]);
    os.ambienceNow = () => new Date(2026, 9, 19, 23, 0); // night
    // On offer: the Manager (weight 2), the window (2), a stretch (1); 0.5 lands on the window.
    expect(os.anshWander(() => 0.5)).toBe(true);
    const a = untilArrived(os);
    expect(at(a)).toEqual([12, 1]);
    expect(a.dir).toBe(Direction.UP);
    expect(saying(os)).toEqual({ ansh: ANSH_WINDOW_LINES.night[1] });
  });

  it('does something else next time', () => {
    const os = office([
      { uid: 'fern', type: 'PLANT', col: 12, row: 5 },
      { uid: 'cm', type: 'COFFEE_MACHINE', col: 12, row: 1 },
    ]);
    expect(os.anshWander(() => 0)).toBe(true);
    untilArrived(os);
    expect(os.npcs.ansh!.wateringCan).toBeDefined();
    untilHome(os);
    expect(os.anshWander(() => 0)).toBe(true);
    const a = untilArrived(os);
    expect(at(a)).toEqual([12, 2]); // the coffee machine, not the plant again
  });

  it('a thought cuts in: the pet is let go and his errand line is dropped', () => {
    const os = office();
    const pet = addPet(os, 12, 3);
    os.addAgent(1, 0, 0, 'd1', true);
    expect(os.anshWander(() => 0)).toBe(true);
    untilArrived(os);
    expect(os.npcLinesShowing()).toHaveLength(1);
    expect(os.anshDo({ at: 0, action: 'visit', targetId: 1, say: 'Hm.', aiWritten: true })).toBe(
      true,
    );
    expect(os.npcLinesShowing()).toEqual([]);
    // The hold is gone: its own FSM moves it again.
    pet.wanderTimer = 0;
    let moved = false;
    for (let i = 0; i < 100 && !moved; i++) {
      run(os, 0.1);
      moved = pet.state !== PetState.IDLE || at(pet).join() !== '12,3';
    }
    expect(moved).toBe(true);
  });
});
