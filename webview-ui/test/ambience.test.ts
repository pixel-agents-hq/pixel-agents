/**
 * Living-office ambience (phase C): the windows' time of day, the real
 * clocks' hands, the night lights' empty rooms, and the name plates on
 * occupied Dev desks — pure rules first, then as OfficeState builds its
 * furniture (never touching the layout it saves).
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLOCK_HAND_COLOR,
  CLOCK_HOUR_HAND_RADIUS,
  CLOCK_MINUTE_HAND_RADIUS,
  CLOCK_PIVOT,
} from '../src/constants.js';
import {
  clockHandAngles,
  clockSprite,
  drawClockHands,
  emptyRoomTiles,
  handPixels,
  handTip,
  timeOfDay,
  windowTypeFor,
  withWindowsAt,
} from '../src/office/engine/ambience.js';
import {
  deskInFront,
  namePlatePlacement,
  plateText,
  plateTextFit,
  plateTextPixels,
} from '../src/office/engine/namePlates.js';
import type { PlacedFurniture } from '../src/office/types.js';
import { Direction } from '../src/office/types.js';
import {
  ambienceOffice,
  CLOCK_FACE_COLOR,
  CLOCK_FACE_SPRITE,
  installAmbienceCatalog,
  NAME_PLATE_SPRITE,
  WINDOW_SPRITES,
} from './ambienceFixture.js';
import { run } from './livingOfficeFixture.js';

beforeAll(installAmbienceCatalog);

const at = (h: number, m = 0) => new Date(2026, 9, 18, h, m);

describe('windows by the time of day', () => {
  it('day 07–17, dusk 17–19 and 06–07, night otherwise', () => {
    const cases: Array<[number, number, string]> = [
      [0, 0, 'night'],
      [5, 59, 'night'],
      [6, 0, 'dusk'],
      [6, 59, 'dusk'],
      [7, 0, 'day'],
      [12, 30, 'day'],
      [16, 59, 'day'],
      [17, 0, 'dusk'],
      [18, 59, 'dusk'],
      [19, 0, 'night'],
      [23, 59, 'night'],
    ];
    for (const [h, m, tod] of cases) expect(timeOfDay(at(h, m)), `${h}:${m}`).toBe(tod);
  });

  it('every window type shows the current one; anything else is left alone', () => {
    for (const type of ['WINDOW_DAY', 'WINDOW_DUSK', 'WINDOW_NIGHT']) {
      expect(windowTypeFor(type, 'night')).toBe('WINDOW_NIGHT');
      expect(windowTypeFor(type, 'dusk')).toBe('WINDOW_DUSK');
      expect(windowTypeFor(type, 'day')).toBe('WINDOW_DAY');
    }
    expect(windowTypeFor('WINDOW', 'night')).toBe('WINDOW');
    expect(windowTypeFor('CLOCK', 'night')).toBe('CLOCK');
  });

  it('swaps only to a variant the catalog has, and returns the input when nothing changes', () => {
    const items: PlacedFurniture[] = [
      { uid: 'w', type: 'WINDOW_DAY', col: 1, row: 0 },
      { uid: 'c', type: 'CLOCK', col: 3, row: 0 },
    ];
    expect(withWindowsAt(items, 'day', () => true)).toBe(items);
    expect(withWindowsAt(items, 'night', () => false)).toBe(items); // no night window in the pack
    const night = withWindowsAt(items, 'night', () => true);
    expect(night.map((f) => f.type)).toEqual(['WINDOW_NIGHT', 'CLOCK']);
    expect(items[0].type).toBe('WINDOW_DAY'); // never mutated
  });

  it('the office draws the window for the hour; the saved layout keeps what was placed', () => {
    const os = ambienceOffice();
    const drawn = () =>
      Object.entries(WINDOW_SPRITES)
        .filter(([, sprite]) => os.furniture.some((f) => f.sprite === sprite))
        .map(([type]) => type);
    os.ambienceNow = () => at(22);
    run(os, 0.3);
    expect(drawn()).toEqual(['WINDOW_NIGHT']);
    os.ambienceNow = () => at(18);
    run(os, 0.3);
    expect(drawn()).toEqual(['WINDOW_DUSK']);
    os.ambienceNow = () => at(9);
    run(os, 0.3);
    expect(drawn()).toEqual(['WINDOW_DAY']);
    expect(os.getLayout().furniture.find((f) => f.uid === 'win')?.type).toBe('WINDOW_DAY');
  });
});

describe('real clocks', () => {
  it('hand angles, clockwise from 12', () => {
    const quarter = Math.PI / 2;
    expect(clockHandAngles(at(3, 0))).toEqual({ hour: quarter, minute: 0 });
    expect(clockHandAngles(at(15, 0))).toEqual({ hour: quarter, minute: 0 });
    const half = clockHandAngles(at(6, 30));
    expect(half.minute).toBeCloseTo(Math.PI);
    expect(half.hour).toBeCloseTo((6.5 / 12) * Math.PI * 2); // halfway to 7
    expect(clockHandAngles(at(0, 0))).toEqual({ hour: 0, minute: 0 });
    expect(clockHandAngles(at(9, 45)).minute).toBeCloseTo(3 * quarter);
  });

  it('the hands reach out from the pivot: up at 12, right at 3, down at 6, left at 9', () => {
    const m = CLOCK_MINUTE_HAND_RADIUS;
    const p = CLOCK_PIVOT;
    expect(handTip(0, m)).toEqual({ x: p.x, y: p.y - m.y });
    expect(handTip(Math.PI / 2, m)).toEqual({ x: p.x + m.x, y: p.y });
    expect(handTip(Math.PI, m)).toEqual({ x: p.x, y: p.y + m.y });
    expect(handTip(1.5 * Math.PI, m)).toEqual({ x: p.x - m.x, y: p.y });
    const line = handPixels({ x: p.x + 3, y: p.y - 3 });
    expect(line[0]).toEqual({ x: p.x, y: p.y });
    expect(line[line.length - 1]).toEqual({ x: p.x + 3, y: p.y - 3 });
    expect(line).toHaveLength(4); // a 1-px diagonal
  });

  it('draws both hands in the hand colour, only over the face', () => {
    const sprite = drawClockHands(CLOCK_FACE_SPRITE, at(3, 0));
    const hand = (x: number, y: number) => sprite[y][x] === CLOCK_HAND_COLOR;
    const p = CLOCK_PIVOT;
    for (let dy = 0; dy <= CLOCK_MINUTE_HAND_RADIUS.y; dy++) expect(hand(p.x, p.y - dy)).toBe(true);
    for (let dx = 0; dx <= CLOCK_HOUR_HAND_RADIUS.x; dx++) expect(hand(p.x + dx, p.y)).toBe(true);
    expect(hand(p.x - 2, p.y)).toBe(false); // nothing at 9
    let changed = 0;
    sprite.forEach((row, y) =>
      row.forEach((c, x) => {
        if (c === CLOCK_FACE_SPRITE[y][x]) return;
        changed++;
        expect(CLOCK_FACE_SPRITE[y][x]).toBe(CLOCK_FACE_COLOR); // a face px, never the rim
      }),
    );
    expect(changed).toBe(CLOCK_MINUTE_HAND_RADIUS.y + 1 + CLOCK_HOUR_HAND_RADIUS.x);
    expect(CLOCK_FACE_SPRITE[p.y][p.x]).toBe(CLOCK_FACE_COLOR); // the face itself is untouched
  });

  it('one sprite per minute: the same until the minute changes', () => {
    const a = clockSprite(CLOCK_FACE_SPRITE, at(10, 7));
    expect(clockSprite(CLOCK_FACE_SPRITE, new Date(2026, 9, 18, 10, 7, 59))).toBe(a);
    const b = clockSprite(CLOCK_FACE_SPRITE, at(10, 8));
    expect(b).not.toBe(a); // redrawn (a minute's step may not move a pixel)
    expect(clockSprite(CLOCK_FACE_SPRITE, at(10, 15))).not.toEqual(a);
  });

  it('the office draws its CLOCK_FACE with the hands of the local time', () => {
    const os = ambienceOffice();
    os.ambienceNow = () => at(3, 0);
    run(os, 0.3);
    const clock = os.furniture.find((f) => f.x === 6 * 16 && f.y === 0);
    expect(clock).toBeDefined();
    expect(clock!.sprite).not.toBe(CLOCK_FACE_SPRITE);
    expect(clock!.sprite).toEqual(drawClockHands(CLOCK_FACE_SPRITE, at(3, 0)));
    os.ambienceNow = () => at(3, 1);
    run(os, 0.3);
    const next = os.furniture.find((f) => f.x === 6 * 16 && f.y === 0)!;
    expect(next.sprite).toEqual(drawClockHands(CLOCK_FACE_SPRITE, at(3, 1)));
  });
});

describe('night lights', () => {
  it('lists the tiles of each labelled room with nobody in it', () => {
    // 3×2: row 0 = A A B, row 1 = B . C
    const tiles = ['A', 'A', 'B', 'B', null, 'C'];
    const empty = emptyRoomTiles(tiles, 3, new Set(['1,0'])); // someone in A
    expect([...empty.keys()].sort()).toEqual(['B', 'C']);
    expect(empty.get('B')).toEqual([
      { col: 2, row: 0 },
      { col: 0, row: 1 },
    ]);
    expect(emptyRoomTiles(tiles, 3, new Set(['1,1'])).size).toBe(3); // unlabelled: no room
    expect(emptyRoomTiles(undefined, 3, new Set()).size).toBe(0);
  });
});

describe('name plates', () => {
  it('the repo in caps, cut to fit; unknown characters become dashes', () => {
    expect(plateText('pixel-agents', 5)).toBe('PIXEL');
    expect(plateText('pixel-agents', 20)).toBe('PIXEL-AGENTS');
    expect(plateText('my_repo.v2', 10)).toBe('MY_REPO.V2');
    expect(plateText('café/app', 8)).toBe('CAF--APP');
    expect(plateText(undefined, 5)).toBe('');
    expect(plateText('repo', 0)).toBe('');
  });

  it('the 3×5 text fits the plate face at every zoom', () => {
    for (let zoom = 1; zoom <= 10; zoom++) {
      const { px, maxChars } = plateTextFit(zoom);
      expect(px).toBeGreaterThanOrEqual(1);
      const { width } = plateTextPixels('W'.repeat(maxChars));
      expect(width * px).toBeLessThanOrEqual(10 * zoom); // the face is 10 px wide
      expect((width + 4) * px).toBeGreaterThan(10 * zoom); // ...and one more wouldn't fit
    }
    expect(plateTextFit(2).maxChars).toBe(5);
    expect(plateTextFit(4).maxChars).toBe(10);
  });

  it('glyph pixels: 3 wide with a 1 px gap', () => {
    const { pixels, width } = plateTextPixels('-I');
    expect(width).toBe(7);
    expect(pixels.filter((p) => p.y === 2 && p.x < 3)).toHaveLength(3); // the dash
    expect(pixels.filter((p) => p.x >= 4).length).toBe(9); // the I
  });

  it('goes on the front edge of the desk in front of the seat, beside the computer', () => {
    const desks = [
      { col: 1, row: 2, w: 3, h: 2, spriteH: 32 },
      { col: 1, row: 3, w: 3, h: 2, spriteH: 32 },
    ];
    const above = { seatCol: 2, seatRow: 1, facingDir: Direction.DOWN };
    const below = { seatCol: 2, seatRow: 5, facingDir: Direction.UP };
    expect(deskInFront(above, desks)).toBe(desks[0]);
    expect(deskInFront(below, desks)).toBe(desks[1]);
    // Desk bottom (row 2 → 32 + 32 = 64) minus the 7 px front panel = the plate's bottom (8).
    expect(namePlatePlacement(above, desks)).toEqual({ x: 3 * 16, y: 64 - 7 - 8, zY: 64.5 });
    expect(namePlatePlacement(below, desks)).toEqual({ x: 3 * 16, y: 80 - 7 - 8, zY: 80.5 });
    // The seat at the desk's right end: the plate goes to its left.
    expect(namePlatePlacement({ ...above, seatCol: 3 }, desks)?.x).toBe(2 * 16);
    expect(namePlatePlacement({ seatCol: 6, seatRow: 1, facingDir: Direction.DOWN }, desks)).toBe(
      null,
    );
  });

  it('an occupied Dev desk shows its agent repo, and frees with the desk; never saved', () => {
    const os = ambienceOffice();
    const plates = () => os.furniture.filter((f) => f.sprite === NAME_PLATE_SPRITE);
    os.addAgent(1, 0, 0, 'd1', true, 'pixel-agents');
    os.addAgent(2, 0, 0, 'd2', true, 'hobbyfi-blog');
    os.addAgent(3, 0, 0, 'c1', true, 'cafe-repo'); // a Café seat: not a Dev desk
    run(os, 0.3);
    expect(
      plates()
        .map((p) => p.plateText)
        .sort(),
    ).toEqual(['hobbyfi-blog', 'pixel-agents']);
    const layoutTypes = os.getLayout().furniture.map((f) => f.type);
    expect(layoutTypes).not.toContain('NAME_PLATE');
    os.removeAgent(1);
    run(os, 0.3);
    expect(plates().map((p) => p.plateText)).toEqual(['hobbyfi-blog']);
  });

  it('no repo, no plate', () => {
    const os = ambienceOffice();
    os.addAgent(1, 0, 0, 'd1', true);
    run(os, 0.3);
    expect(os.furniture.some((f) => f.sprite === NAME_PLATE_SPRITE)).toBe(false);
  });
});
