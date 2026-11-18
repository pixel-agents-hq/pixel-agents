/**
 * Wall tile auto-tiling: sprite storage and bitmask-based piece selection.
 *
 * Stores wall tile sets loaded from individual PNGs in assets/walls/.
 * Each set contains 16 wall sprites (one per 4-bit bitmask).
 * At render time, each wall tile's 4 cardinal neighbors are checked to build
 * a bitmask, and the corresponding sprite is drawn directly.
 *
 * Every wall tile wears a set (`OfficeLayout.wallSets`, absent = set 0), and
 * sets of different heights (a cubicle wall against a full one) never join:
 * each closes its own end, so a low partition reads as standing against the
 * wall instead of melting into it. A set's height is read off its art (the
 * first opaque row of its lone piece), so a new sheet needs no metadata.
 *
 * Bitmask convention: N=1, E=2, S=4, W=8. Out-of-bounds = NOT wall.
 */

import type { ColorValue } from '../components/ui/types.js';
import { WALL_CAP_ROWS } from '../constants.js';
import { getColorizedSprite } from './colorize.js';
import type { FurnitureInstance, SpriteData, TileType as TileTypeVal } from './types.js';
import { TILE_SIZE, TileType } from './types.js';

/** Wall tile sets: each set has 16 sprites indexed by bitmask (0-15) */
let wallSets: SpriteData[][] = [];
/** Each set's height in pixels (rows of its lone piece from the first opaque one). */
let wallSetHeights: number[] = [];

/** Set wall tile sets (called once when extension sends wallTilesLoaded) */
export function setWallSprites(sets: SpriteData[][]): void {
  wallSets = sets;
  wallSetHeights = sets.map(spriteHeight);
  seamless.clear();
}

/**
 * Seams a piece drops where the wall is thicker than one tile. The 4-bit mask
 * can't see diagonals, so a piece running south (or north) along a joined side
 * keeps that side's outline: right when the neighbour beside it is a plain
 * run with its front face there, wrong when the neighbour runs the same way —
 * then the two top faces would show a dashed seam between them.
 *   NE / NW: the corner pixel of the cap's first row (an inner-corner mark).
 *   SE / SW: the column under the cap.
 */
const SEAM_NE = 1;
const SEAM_SE = 2;
const SEAM_SW = 4;
const SEAM_NW = 8;

/** Pieces with seams dropped, by `set:mask:seams`. */
const seamless = new Map<string, SpriteData>();

/** The piece with the given seams filled from the column next to them. */
function withoutSeams(set: number, mask: number, seams: number): SpriteData {
  const raw = wallSets[set][mask];
  if (seams === 0) return raw;
  const key = `${set}:${mask}:${seams}`;
  const cached = seamless.get(key);
  if (cached) return cached;
  const top = raw.length - wallSetHeights[set];
  const sprite = raw.map((row) => [...row]);
  const last = (sprite[0]?.length ?? 0) - 1;
  const fill = (x: number, from: number, y0: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(sprite.length, y1); y++) {
      if (sprite[y][x] !== '') sprite[y][x] = sprite[y][from];
    }
  };
  if (seams & SEAM_NE) fill(last, last - 1, top, top + 1);
  if (seams & SEAM_NW) fill(0, 1, top, top + 1);
  if (seams & SEAM_SE) fill(last, last - 1, top + WALL_CAP_ROWS, sprite.length);
  if (seams & SEAM_SW) fill(0, 1, top + WALL_CAP_ROWS, sprite.length);
  seamless.set(key, sprite);
  return sprite;
}

/** Rows from a sprite's first non-transparent row to its foot. */
function spriteHeight(set: SpriteData[]): number {
  const lone = set[0] ?? [];
  const first = lone.findIndex((row) => row.some((px) => px !== ''));
  return first === -1 ? 0 : lone.length - first;
}

/** Check if wall sprites have been loaded */
export function hasWallSprites(): boolean {
  return wallSets.length > 0;
}

/** Get number of available wall sets */
export function getWallSetCount(): number {
  return wallSets.length;
}

/** The set a tile wears: its own when that set is loaded, else set 0. */
export function wallSetAt(sets: Array<number | null> | undefined, idx: number): number {
  const set = sets?.[idx] ?? 0;
  return set >= 0 && set < wallSets.length ? set : 0;
}

/**
 * A wall set's thumbnail: a short straight run (west end, east end), coloured,
 * so its face texture shows. Null when the set isn't loaded.
 */
export function getWallSetPreviewSprites(
  setIndex: number,
  color: ColorValue,
): [SpriteData, SpriteData] | null {
  const set = wallSets[setIndex];
  if (!set?.[2] || !set[8]) return null;
  const key = (mask: number) =>
    `wall-${setIndex}-${mask}-${color.h}-${color.s}-${color.b}-${color.c}`;
  return [
    getColorizedSprite(key(2), set[2], { ...color, colorize: true }),
    getColorizedSprite(key(8), set[8], { ...color, colorize: true }),
  ];
}

/**
 * Build the 4-bit neighbor bitmask for a wall tile at (col, row): a neighbor
 * counts when it is a wall of the same height. Plus the seams to drop where a
 * diagonal joins too (see `withoutSeams`).
 */
function buildWallMask(
  col: number,
  row: number,
  tileMap: TileTypeVal[][],
  setOf: (col: number, row: number) => number,
): { mask: number; seams: number } {
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const height = wallSetHeights[setOf(col, row)];
  const joins = (c: number, r: number) =>
    tileMap[r][c] === TileType.WALL && wallSetHeights[setOf(c, r)] === height;

  const n = row > 0 && joins(col, row - 1);
  const e = col < tmCols - 1 && joins(col + 1, row);
  const s = row < tmRows - 1 && joins(col, row + 1);
  const w = col > 0 && joins(col - 1, row);
  const mask = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);

  // A diagonal that joins too: the block is solid there, no seam between.
  let seams = 0;
  if (n && e && joins(col + 1, row - 1)) seams |= SEAM_NE;
  if (s && e && joins(col + 1, row + 1)) seams |= SEAM_SE;
  if (s && w && joins(col - 1, row + 1)) seams |= SEAM_SW;
  if (n && w && joins(col - 1, row - 1)) seams |= SEAM_NW;
  return { mask, seams };
}

/**
 * Build FurnitureInstance-like objects for all wall tiles so they can participate
 * in z-sorting with furniture and characters. Each tile is drawn in its own set
 * and colour (Colorize mode, like floors); an uncoloured wall keeps its raw art.
 */
export function getWallInstances(
  tileMap: TileTypeVal[][],
  tileColors?: Array<ColorValue | null>,
  cols?: number,
  tileWallSets?: Array<number | null>,
): FurnitureInstance[] {
  if (wallSets.length === 0) return [];
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;
  const setOf = (c: number, r: number) => wallSetAt(tileWallSets, r * layoutCols + c);
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      if (tileMap[r][c] !== TileType.WALL) continue;
      const setIndex = setOf(c, r);
      const { mask, seams } = buildWallMask(c, r, tileMap, setOf);
      if (!wallSets[setIndex][mask]) continue;
      const raw = withoutSeams(setIndex, mask, seams);
      const color = tileColors?.[r * layoutCols + c];
      const sprite = color
        ? getColorizedSprite(
            `wall-${setIndex}-${mask}-s${seams}-${color.h}-${color.s}-${color.b}-${color.c}`,
            raw,
            { ...color, colorize: true },
          )
        : raw;
      instances.push({
        sprite,
        x: c * TILE_SIZE,
        // Anchor sprite at bottom of tile — tall sprites extend upward
        y: r * TILE_SIZE + TILE_SIZE - raw.length,
        zY: (r + 1) * TILE_SIZE,
      });
    }
  }
  return instances;
}

/**
 * Compute the flat fill hex color for a wall tile with a given ColorValue.
 * Uses same Colorize algorithm as floor tiles: 50% gray → HSL.
 */
export function wallColorToHex(color: ColorValue): string {
  const { h, s, b, c } = color;
  // Start with 50% gray (wall base)
  let lightness = 0.5;

  // Apply contrast
  if (c !== 0) {
    const factor = (100 + c) / 100;
    lightness = 0.5 + (lightness - 0.5) * factor;
  }

  // Apply brightness
  if (b !== 0) {
    lightness = lightness + b / 200;
  }

  lightness = Math.max(0, Math.min(1, lightness));

  // HSL to hex (same as colorize.ts hslToHex)
  const satFrac = s / 100;
  const ch = (1 - Math.abs(2 * lightness - 1)) * satFrac;
  const hp = h / 60;
  const x = ch * (1 - Math.abs((hp % 2) - 1));
  let r1: number;
  let g1: number;
  let b1: number;

  if (hp < 1) {
    r1 = ch;
    g1 = x;
    b1 = 0;
  } else if (hp < 2) {
    r1 = x;
    g1 = ch;
    b1 = 0;
  } else if (hp < 3) {
    r1 = 0;
    g1 = ch;
    b1 = x;
  } else if (hp < 4) {
    r1 = 0;
    g1 = x;
    b1 = ch;
  } else if (hp < 5) {
    r1 = x;
    g1 = 0;
    b1 = ch;
  } else {
    r1 = ch;
    g1 = 0;
    b1 = x;
  }

  const m = lightness - ch / 2;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));

  return `#${clamp(r1).toString(16).padStart(2, '0')}${clamp(g1).toString(16).padStart(2, '0')}${clamp(b1).toString(16).padStart(2, '0')}`;
}
