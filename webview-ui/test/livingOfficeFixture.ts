/**
 * Shared fixture for the living-office tests (zones, routing, entrance):
 * a tiny furniture catalog with the furniture the zones key on, and layouts
 * drawn as ASCII maps — one character per tile, a letter per zone label.
 */

import { expect } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

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

/** Distinct sprite objects, so a test can tell which rack frame is drawn. */
export const RACK_OFF_SPRITE: SpriteData = [['']];
export const RACK_ON_SPRITES: SpriteData[] = [[['']], [['']]];

/** Chairs, the ashtray stand and the server rack (off + 2 on frames). */
export function installZoneCatalog(): void {
  const rack = {
    category: 'electronics',
    height: 32,
    footprintH: 2,
    backgroundTiles: 1,
    groupId: 'SERVER_RACK',
  };
  const ok = buildDynamicCatalog({
    catalog: [
      asset('CHAIR', { category: 'chairs' }),
      asset('ASHTRAY_STAND', { height: 32, footprintH: 2, backgroundTiles: 1 }),
      asset('SERVER_RACK_OFF', { ...rack, state: 'off' }),
      asset('SERVER_RACK_ON_1', { ...rack, state: 'on', animationGroup: 'RACK_ON', frame: 0 }),
      asset('SERVER_RACK_ON_2', { ...rack, state: 'on', animationGroup: 'RACK_ON', frame: 1 }),
    ],
    sprites: {
      CHAIR: [['']],
      ASHTRAY_STAND: [['']],
      SERVER_RACK_OFF: RACK_OFF_SPRITE,
      SERVER_RACK_ON_1: RACK_ON_SPRITES[0],
      SERVER_RACK_ON_2: RACK_ON_SPRITES[1],
    },
  });
  expect(ok).toBe(true);
}

const LABELS: Record<string, string> = {
  D: 'Dev',
  K: 'Smoke',
  S: 'Server',
  L: 'Lounge',
  M: 'Meeting',
  C: 'Cafe',
  E: 'Entrance',
  X: 'Engineering', // a user's own Area: not a zone
};

/**
 * A layout from an ASCII map: `W` wall, `.` unlabeled floor, a letter = floor
 * in that zone (see LABELS). `withAreas: false` drops the Areas entirely.
 */
export function layoutFrom(
  map: string[],
  furniture: PlacedFurniture[],
  { withAreas = true }: { withAreas?: boolean } = {},
): OfficeLayout {
  const rows = map.length;
  const cols = map[0].length;
  const tiles: TileType[] = [];
  const areaTiles: Array<string | null> = [];
  for (const line of map) {
    expect(line.length).toBe(cols);
    for (const ch of line) {
      tiles.push(ch === 'W' ? TileType.WALL : TileType.FLOOR_1);
      areaTiles.push(LABELS[ch] ?? null);
    }
  }
  // Zones read only the per-tile labels (`areas` just colours them in the editor).
  const layout: OfficeLayout = { version: 1, cols, rows, tiles, furniture };
  if (withAreas) layout.areaTiles = areaTiles;
  return layout;
}

export const chair = (uid: string, col: number, row: number): PlacedFurniture => ({
  uid,
  type: 'CHAIR',
  col,
  row,
});

/**
 * The test office (20×10): Dev desks top-left, the Smoke terrace and Server
 * room top-right, Lounge / Meeting / Cafe / Entrance along the bottom, and
 * the main door in the east wall at (19,7).
 */
export const OFFICE_MAP = [
  'WWWWWWWWWWWWWWWWWWWW',
  'WDDDDDDDDDKKKKSSSSSW',
  'WDDDDDDDDDKKKKSSSSSW',
  'WDDDDDDDDDKKKKSSSSSW',
  'WDDDDDDDDDKKKKSSSSSW',
  'WLLLLMMMMMCCCCEEEEEW',
  'WLLLLMMMMMCCCCEEEEEW',
  'WLLLLMMMMMCCCCEEEEEE',
  'WLLLLMMMMMCCCCEEEEEW',
  'WWWWWWWWWWWWWWWWWWWW',
];

export const OFFICE_FURNITURE: PlacedFurniture[] = [
  chair('d1', 2, 2),
  chair('d2', 4, 2),
  chair('d3', 6, 2),
  // The ashtray stands on (11,2) (background row, walkable) and (11,3).
  { uid: 'ashtray', type: 'ASHTRAY_STAND', col: 11, row: 2 },
  // Racks on (15|16, 1) (background) and (15|16, 2); in front of them: row 3.
  { uid: 'rack1', type: 'SERVER_RACK_OFF', col: 15, row: 1 },
  { uid: 'rack2', type: 'SERVER_RACK_OFF', col: 16, row: 1 },
  chair('l1', 2, 6),
  chair('l2', 3, 6),
  chair('m0', 6, 5),
  chair('m1', 7, 6),
  chair('m2', 8, 6),
  chair('c1', 11, 6),
  chair('c2', 12, 6),
];

export function zonedOffice(
  furniture: PlacedFurniture[] = OFFICE_FURNITURE,
  map: string[] = OFFICE_MAP,
): OfficeState {
  const os = new OfficeState(layoutFrom(map, furniture));
  // No Café coffee runs at the gaps between tools unless a test asks for them
  // (coffeeRuns.test.ts): every other behaviour is tested without the detour.
  os.coffeeRandom = () => 1;
  return os;
}

/** Simulate `seconds` of game time in small steps. */
export function run(os: OfficeState, seconds: number, dt = 0.05): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) os.update(dt);
}
