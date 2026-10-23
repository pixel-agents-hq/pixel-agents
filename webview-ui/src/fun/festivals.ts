/**
 * Festival decorations by local date (docs/office/DESIGN.md, phase E): Diwali
 * lights and diyas, Holi colours, a New Year banner. A pure date table plus the
 * placement of the runtime-only decorations (never saved to the layout).
 */

import {
  FESTIVAL_LIGHTS_SKIP_PARTS,
  FESTIVAL_MAX_DIYAS,
  FESTIVAL_MAX_HOLI_BOWLS,
  FUN_TYPE,
} from './funConstants.js';

export type Festival = 'diwali' | 'holi' | 'newYear';

/**
 * Diwali and Holi follow the Hindu lunisolar calendar, so their Gregorian
 * dates move every year. Looked up (2026-10-18) against several panchang
 * sources (smartpuja.com, dekhopanchang.com, publicholidays.com, Wikipedia):
 *  - Diwali (Lakshmi Puja): Sun 8 Nov 2026; Fri 29 Oct 2027. Decorations run
 *    from Dhanteras (2 days before) to Bhai Dooj (2 days after).
 *  - Holi: Holika Dahan Tue 3 Mar 2026 → Rangwali Holi Wed 4 Mar 2026;
 *    Holika Dahan Sun 21 Mar 2027 → Holi Mon 22 Mar 2027.
 * Add the next years' rows when they are known; missing years just skip.
 */
export const FESTIVAL_DATES: ReadonlyArray<{ festival: Festival; from: string; to: string }> = [
  { festival: 'holi', from: '2026-03-03', to: '2026-03-04' },
  { festival: 'diwali', from: '2026-11-06', to: '2026-11-10' },
  { festival: 'holi', from: '2027-03-21', to: '2027-03-22' },
  { festival: 'diwali', from: '2027-10-27', to: '2027-10-31' },
];

/** Local calendar date, YYYY-MM-DD. */
export function localDateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The festival on this local date, if any. New Year: 31 Dec – 2 Jan, every year. */
export function festivalOn(d: Date): Festival | null {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 12 && day === 31) || (m === 1 && day <= 2)) return 'newYear';
  const key = localDateKey(d);
  for (const row of FESTIVAL_DATES) {
    if (key >= row.from && key <= row.to) return row.festival;
  }
  return null;
}

// ── Placement ──────────────────────────────────────────────────

export interface DecorPlacement {
  type: string;
  col: number;
  row: number;
}

/** What placement needs to know about the office, catalog injected (pure, Node-testable). */
export interface DecorInput {
  cols: number;
  rows: number;
  /** Is (col,row) a wall tile? */
  isWall: (col: number, row: number) => boolean;
  /** The zone label of a floor tile ('Dev', 'Lounge', ...), or null. */
  zoneAt: (col: number, row: number) => string | null;
  furniture: ReadonlyArray<{ type: string; col: number; row: number }>;
  /** Footprint + flags of a furniture type; undefined when unknown. */
  entry: (
    type: string,
  ) => { w: number; h: number; isDesk: boolean; onWall: boolean; onSurface: boolean } | undefined;
}

/**
 * A room's top wall: for each column, the wall tile right above the zone's
 * topmost floor tile. Wall items (32 px tall, 2 rows) hang with their bottom
 * row on that wall tile, like the windows do.
 */
export function topWallColumns(
  input: DecorInput,
  zone: string,
): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  for (let col = 0; col < input.cols; col++) {
    for (let row = 1; row < input.rows; row++) {
      if (input.zoneAt(col, row) !== zone) continue;
      if (input.isWall(col, row - 1) && row - 2 >= 0) out.push({ col, row: row - 2 });
      break; // only the topmost floor tile of the column
    }
  }
  return out;
}

/** Tiles covered by wall items whose type contains one of these parts. */
function wallItemTiles(input: DecorInput, parts: readonly string[] | null): Set<string> {
  const tiles = new Set<string>();
  for (const f of input.furniture) {
    const e = input.entry(f.type);
    if (!e?.onWall) continue;
    if (parts && !parts.some((p) => f.type.includes(p))) continue;
    for (let dr = 0; dr < e.h; dr++) {
      for (let dc = 0; dc < e.w; dc++) tiles.add(`${f.col + dc},${f.row + dr}`);
    }
  }
  return tiles;
}

/** Free desk/table surface tiles in these zones (no surface item on them yet), row-major. */
export function freeSurfaceTiles(
  input: DecorInput,
  zones: readonly string[],
): Array<{ col: number; row: number }> {
  const taken = new Set<string>();
  for (const f of input.furniture) {
    const e = input.entry(f.type);
    if (!e?.onSurface) continue;
    for (let dr = 0; dr < e.h; dr++) {
      for (let dc = 0; dc < e.w; dc++) taken.add(`${f.col + dc},${f.row + dr}`);
    }
  }
  const out: Array<{ col: number; row: number }> = [];
  const seen = new Set<string>();
  for (const f of input.furniture) {
    const e = input.entry(f.type);
    if (!e?.isDesk) continue;
    for (let dr = 0; dr < e.h; dr++) {
      for (let dc = 0; dc < e.w; dc++) {
        const col = f.col + dc;
        const row = f.row + dr;
        const k = `${col},${row}`;
        if (taken.has(k) || seen.has(k)) continue;
        const zone = input.zoneAt(col, row);
        if (!zone || !zones.includes(zone)) continue;
        seen.add(k);
        out.push({ col, row });
      }
    }
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

/** Every `step`-th item, at most `max`, spread over the list. */
function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
}

/** String lights along the Dev and Lounge top walls (not over clocks / calendars / boards). */
function stringLights(input: DecorInput): DecorPlacement[] {
  const skip = wallItemTiles(input, FESTIVAL_LIGHTS_SKIP_PARTS);
  const out: DecorPlacement[] = [];
  for (const zone of ['Dev', 'Lounge']) {
    for (const { col, row } of topWallColumns(input, zone)) {
      if (skip.has(`${col},${row}`) || skip.has(`${col},${row + 1}`)) continue;
      out.push({ type: `${FUN_TYPE.STRING_LIGHTS}_ON_1`, col, row });
    }
  }
  return out;
}

/** The New Year banner: on the Lounge top wall, preferring 3 columns no wall item covers. */
function newYearBanner(input: DecorInput): DecorPlacement[] {
  const wall = topWallColumns(input, 'Lounge');
  if (wall.length < 3) return [];
  const covered = wallItemTiles(input, null);
  const free = (i: number) =>
    !covered.has(`${wall[i].col},${wall[i].row}`) &&
    !covered.has(`${wall[i].col},${wall[i].row + 1}`);
  const runs: number[] = [];
  for (let i = 0; i + 2 < wall.length; i++) {
    const contiguous =
      wall[i + 1].col === wall[i].col + 1 &&
      wall[i + 2].col === wall[i].col + 2 &&
      wall[i + 1].row === wall[i].row &&
      wall[i + 2].row === wall[i].row;
    if (contiguous) runs.push(i);
  }
  if (runs.length === 0) return [];
  const mid = (wall.length - 3) / 2;
  const byCentre = (a: number, b: number) => Math.abs(a - mid) - Math.abs(b - mid);
  const clear = runs.filter((i) => free(i) && free(i + 1) && free(i + 2)).sort(byCentre);
  const i = clear[0] ?? [...runs].sort(byCentre)[0];
  return [{ type: FUN_TYPE.NEW_YEAR_BANNER, col: wall[i].col, row: wall[i].row }];
}

/** The runtime-only decorations for a festival. */
export function festivalDecorations(
  festival: Festival | null,
  input: DecorInput,
): DecorPlacement[] {
  switch (festival) {
    case 'diwali':
      return [
        ...stringLights(input),
        ...spread(freeSurfaceTiles(input, ['Dev', 'Lounge', 'Cafe']), FESTIVAL_MAX_DIYAS).map(
          (t) => ({ type: `${FUN_TYPE.DIYA}_ON_1`, ...t }),
        ),
      ];
    case 'holi':
      return spread(freeSurfaceTiles(input, ['Lounge', 'Cafe']), FESTIVAL_MAX_HOLI_BOWLS).map(
        (t) => ({ type: FUN_TYPE.HOLI_COLORS, ...t }),
      );
    case 'newYear':
      return newYearBanner(input);
    default:
      return [];
  }
}
