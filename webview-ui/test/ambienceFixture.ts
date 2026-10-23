/**
 * Shared fixture for the ambience tests (phase C): a tiny catalog with desks,
 * chairs, the wall windows, the live clock, the name plate, the coffee
 * machine and the reception desk, and an office with a Dev room, a Café with
 * a counter and an Entrance with a reception desk and the door.
 */

import { expect } from 'vitest';

import { COFFEE_CUP_COLOR, NAME_PLATE_TEXT_COLOR } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { PlacedFurniture, SpriteData } from '../src/office/types.js';
import { chair, layoutFrom } from './livingOfficeFixture.js';

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

const blank = (w: number, h: number, color = ''): SpriteData =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => color));

/** Distinct sprite objects, so a test can tell which window is drawn. */
export const WINDOW_SPRITES = {
  WINDOW_DAY: blank(16, 16),
  WINDOW_DUSK: blank(16, 16),
  WINDOW_NIGHT: blank(16, 16),
};

/** A light face colour and a dark rim colour (any light/dark shared colours do). */
export const CLOCK_FACE_COLOR = COFFEE_CUP_COLOR;
const CLOCK_RIM_COLOR = NAME_PLATE_TEXT_COLOR;

/** The office pack's clock face: a light ellipse (x3..12, y13..19) with a dark rim. */
export function clockFaceSprite(): SpriteData {
  const s = blank(16, 32);
  for (let y = 11; y <= 21; y++) {
    for (let x = 1; x <= 14; x++) {
      const nx = (x - 7.5) / 6.5;
      const ny = (y - 16) / 5;
      const d = nx * nx + ny * ny;
      if (d <= 0.62) s[y][x] = CLOCK_FACE_COLOR;
      else if (d <= 1.1) s[y][x] = CLOCK_RIM_COLOR;
    }
  }
  return s;
}
export const CLOCK_FACE_SPRITE = clockFaceSprite();
export const NAME_PLATE_SPRITE = blank(16, 16);

export function installAmbienceCatalog(): void {
  const desk = {
    category: 'desks',
    width: 48,
    height: 32,
    footprintW: 3,
    footprintH: 2,
    isDesk: true,
    backgroundTiles: 1,
  };
  const ok = buildDynamicCatalog({
    catalog: [
      asset('CHAIR', { category: 'chairs' }),
      asset('DESK', desk),
      asset('RECEPTION_DESK', desk),
      asset('COFFEE_MACHINE', {
        category: 'electronics',
        height: 32,
        footprintH: 2,
        backgroundTiles: 1,
        canPlaceOnSurfaces: true,
      }),
      asset('NAME_PLATE', { canPlaceOnSurfaces: true }),
      asset('WINDOW_DAY', { category: 'wall', canPlaceOnWalls: true }),
      asset('WINDOW_DUSK', { category: 'wall', canPlaceOnWalls: true }),
      asset('WINDOW_NIGHT', { category: 'wall', canPlaceOnWalls: true }),
      asset('CLOCK_FACE', { category: 'wall', canPlaceOnWalls: true, height: 32 }),
    ],
    sprites: {
      CHAIR: [['']],
      DESK: blank(48, 32),
      RECEPTION_DESK: blank(48, 32),
      COFFEE_MACHINE: blank(16, 32),
      NAME_PLATE: NAME_PLATE_SPRITE,
      ...WINDOW_SPRITES,
      CLOCK_FACE: CLOCK_FACE_SPRITE,
    },
  });
  expect(ok).toBe(true);
}

/**
 * The test office (14×8): Dev desks on the left (a double desk, seats d1 above
 * it facing down and d2 below it facing up), the Café counter (a desk with
 * the coffee machine on it; the counter spot is (7,4)) with a seat c1 at it,
 * and the Entrance with the reception desk, its chair r1, and the door (13,5).
 */
export const AMBIENCE_MAP = [
  'WWWWWWWWWWWWWW',
  'WDDDDDDCCCEEEW',
  'WDDDDDDCCCEEEW',
  'WDDDDDDCCCEEEW',
  'WDDDDDDCCCEEEW',
  'WDDDDDDCCCEEEE',
  'WDDDDDDCCCEEEW',
  'WWWWWWWWWWWWWW',
];

export const AMBIENCE_FURNITURE: PlacedFurniture[] = [
  { uid: 'win', type: 'WINDOW_DAY', col: 3, row: 0 },
  { uid: 'clock', type: 'CLOCK_FACE', col: 6, row: 0 },
  chair('d1', 2, 1),
  { uid: 'desk1', type: 'DESK', col: 1, row: 2 },
  { uid: 'desk2', type: 'DESK', col: 1, row: 3 },
  chair('d2', 2, 5),
  { uid: 'counter', type: 'DESK', col: 7, row: 2 },
  { uid: 'coffee', type: 'COFFEE_MACHINE', col: 7, row: 2 },
  chair('c1', 9, 4),
  chair('r1', 11, 2),
  { uid: 'reception', type: 'RECEPTION_DESK', col: 10, row: 3 },
];

export function ambienceOffice(
  furniture: PlacedFurniture[] = AMBIENCE_FURNITURE,
  map: string[] = AMBIENCE_MAP,
): OfficeState {
  return new OfficeState(layoutFrom(map, furniture));
}
