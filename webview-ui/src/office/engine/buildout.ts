/**
 * The Buildout (CONTEXT.md) as a plan: what an agent's layout edit changed,
 * and when each change shows. Pure and DOM-free — OfficeState holds a plan
 * and its clock, the renderer draws what `buildoutFrame` says is shown.
 *
 * - **What counts**: per tile, a change of floor pattern or colour, wall
 *   (added, removed, set, colour) or carpet; per furniture item (by uid), one
 *   placed, removed, or changed in any way (moved, turned, recoloured,
 *   toggled: the old one dissolves as the new one appears, at the new one's
 *   turn). Areas are invisible paint
 *   and pets come and go on their own, so neither is animated.
 * - **Order**: by distance from the origin (Euclidean, to the tile or the
 *   footprint's centre), nearest first, one by one: BUILDOUT_STEP_SEC apart,
 *   squeezed so the last starts by BUILDOUT_MAX_SEC minus a dissolve.
 * - **Additions** simply appear at their time; until then the tile shows what
 *   it was and the item isn't there. **Removals** (a wall gone, floor erased
 *   to void, an item gone or replaced) dissolve in matrix rain from their time
 *   for MATRIX_EFFECT_DURATION_SEC; until then the old one stays.
 * - Carpets swap at their time without rain (their junction art is drawn
 *   for the whole layer at once).
 */

import type { ColorValue } from '../../components/ui/types.js';
import {
  BUILDOUT_MAX_SEC,
  BUILDOUT_STEP_SEC,
  MATRIX_EFFECT_DURATION_SEC,
} from '../../constants.js';
import type { CarpetTile, OfficeLayout, PlacedFurniture } from '../types.js';
import { TileType } from '../types.js';
import { matrixEffectSeeds } from './matrixEffectState.js';

type Tile = { col: number; row: number };

/** Something the edit took away, dissolving in matrix rain from `at`. */
export type BuildoutRemoval =
  | { kind: 'furniture'; item: PlacedFurniture; at: number; seeds: number[] }
  | { kind: 'wall' | 'floor'; col: number; row: number; at: number; seeds: number[] };

export interface BuildoutPlan {
  origin: Tile;
  /** The layout before the edit, lined up with the new grid (shifted, resized). */
  before: OfficeLayout;
  after: OfficeLayout;
  /** Tiles whose look changed, and when each switches to the new one. */
  tiles: Array<{ index: number; at: number }>;
  /** Items the edit placed (or changed), by uid, and when each appears. */
  added: Array<{ uid: string; at: number }>;
  removed: BuildoutRemoval[];
  /** Every change's time, ascending: the frame shown changes only as one passes. */
  times: number[];
  /** When the last change is done (s). */
  duration: number;
}

/** What the renderer needs of a Buildout playing: the removals dissolving
 *  now, and the layout before it (lined up with the new grid) to draw them from. */
export interface BuildoutRender {
  dissolving: BuildoutFrame['dissolving'];
  before: OfficeLayout;
  beforeTileMap: TileType[][];
}

/** What a frame of the Buildout shows. */
export interface BuildoutFrame {
  /** The layout as shown: the new one, with changes not yet due still as before. */
  layout: OfficeLayout;
  /** Removals dissolving now: `timer` seconds into their rain. */
  dissolving: Array<BuildoutRemoval & { timer: number }>;
}

/** The footprint of a furniture type (1×1 when unknown). */
export type FootprintOf = (type: string) => { w: number; h: number } | null;

/** The layout `before`, as the grid `after` has it: tiles moved by `shift`
 *  (a resize growing or cutting the left/top), tiles new to the grid void. */
export function alignLayout(
  before: OfficeLayout,
  cols: number,
  rows: number,
  shift: Tile = { col: 0, row: 0 },
): OfficeLayout {
  if (before.cols === cols && before.rows === rows && shift.col === 0 && shift.row === 0) {
    return before;
  }
  const n = cols * rows;
  const tiles = new Array<TileType>(n).fill(TileType.VOID);
  const tileColors = new Array<ColorValue | null>(n).fill(null);
  const wallSets = new Array<number | null>(n).fill(null);
  const carpetTiles = new Array<CarpetTile | null>(n).fill(null);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const oc = col - shift.col;
      const or = row - shift.row;
      if (oc < 0 || or < 0 || oc >= before.cols || or >= before.rows) continue;
      const from = or * before.cols + oc;
      const to = row * cols + col;
      tiles[to] = before.tiles[from] ?? TileType.VOID;
      tileColors[to] = before.tileColors?.[from] ?? null;
      wallSets[to] = before.wallSets?.[from] ?? null;
      carpetTiles[to] = before.carpetTiles?.[from] ?? null;
    }
  }
  return {
    ...before,
    cols,
    rows,
    tiles,
    tileColors,
    wallSets,
    carpetTiles,
    furniture: before.furniture.map((f) => ({
      ...f,
      col: f.col + shift.col,
      row: f.row + shift.row,
    })),
  };
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function sameTile(a: OfficeLayout, b: OfficeLayout, i: number): boolean {
  const tile = a.tiles[i];
  if (tile !== b.tiles[i]) return false;
  if (tile === TileType.VOID) return true;
  if (!same(a.tileColors?.[i], b.tileColors?.[i])) return false;
  if (!same(a.carpetTiles?.[i], b.carpetTiles?.[i])) return false;
  // Absent = set 0 (layouts from before wall sets).
  return tile !== TileType.WALL || (a.wallSets?.[i] ?? 0) === (b.wallSets?.[i] ?? 0);
}

const sameItem = (a: PlacedFurniture, b: PlacedFurniture): boolean =>
  a.type === b.type && a.col === b.col && a.row === b.row && same(a.color, b.color);

/**
 * Plan the Buildout of `after` over `before` (the office's layout until now)
 * from `origin` (in `after`'s grid; `shift` = how the edit's resizes moved
 * `before`'s tiles). Null when nothing visible changed.
 */
export function planBuildout(
  before: OfficeLayout,
  after: OfficeLayout,
  origin: Tile,
  opts: { shift?: Tile; footprint?: FootprintOf } = {},
): BuildoutPlan | null {
  const old = alignLayout(before, after.cols, after.rows, opts.shift);
  const dist = (col: number, row: number): number => Math.hypot(col - origin.col, row - origin.row);
  const centre = (f: PlacedFurniture): number => {
    const fp = opts.footprint?.(f.type) ?? { w: 1, h: 1 };
    return dist(f.col + (fp.w - 1) / 2, f.row + (fp.h - 1) / 2);
  };

  type Change =
    | { d: number; kind: 'tile'; index: number; removal: 'wall' | 'floor' | null }
    | { d: number; kind: 'add'; uid: string }
    | { d: number; kind: 'remove'; item: PlacedFurniture }
    // A changed item (moved, turned, recoloured, toggled): the old one dissolves
    // as the new one appears, at the new one's turn — never both at once.
    | { d: number; kind: 'replace'; uid: string; item: PlacedFurniture };
  const changes: Change[] = [];

  for (let i = 0; i < after.tiles.length; i++) {
    if (sameTile(old, after, i)) continue;
    const was = old.tiles[i];
    const now = after.tiles[i];
    const removal =
      was === TileType.WALL && now !== TileType.WALL
        ? 'wall'
        : was !== TileType.VOID && was !== TileType.WALL && now === TileType.VOID
          ? 'floor'
          : null;
    changes.push({
      d: dist(i % after.cols, Math.floor(i / after.cols)),
      kind: 'tile',
      index: i,
      removal,
    });
  }

  const oldByUid = new Map(old.furniture.map((f) => [f.uid, f]));
  const newByUid = new Map(after.furniture.map((f) => [f.uid, f]));
  for (const f of old.furniture) {
    if (!newByUid.has(f.uid)) changes.push({ d: centre(f), kind: 'remove', item: f });
  }
  for (const f of after.furniture) {
    const was = oldByUid.get(f.uid);
    if (!was) changes.push({ d: centre(f), kind: 'add', uid: f.uid });
    else if (!sameItem(was, f))
      changes.push({ d: centre(f), kind: 'replace', uid: f.uid, item: was });
  }

  if (changes.length === 0) return null;
  // Stable: equally far changes keep tile order, then removals, then additions.
  changes.sort((a, b) => a.d - b.d);

  const dissolves = changes.some((c) => (c.kind === 'tile' ? c.removal : c.kind !== 'add'));
  const spread = BUILDOUT_MAX_SEC - (dissolves ? MATRIX_EFFECT_DURATION_SEC : 0);
  const step = changes.length > 1 ? Math.min(BUILDOUT_STEP_SEC, spread / (changes.length - 1)) : 0;

  const plan: BuildoutPlan = {
    origin: { ...origin },
    before: old,
    after,
    tiles: [],
    added: [],
    removed: [],
    times: [],
    duration: 0,
  };
  changes.forEach((c, k) => {
    const at = k * step;
    plan.times.push(at);
    let end = at;
    if (c.kind === 'tile') {
      plan.tiles.push({ index: c.index, at });
      if (c.removal) {
        plan.removed.push({
          kind: c.removal,
          col: c.index % after.cols,
          row: Math.floor(c.index / after.cols),
          at,
          seeds: matrixEffectSeeds(),
        });
        end += MATRIX_EFFECT_DURATION_SEC;
      }
    } else {
      if (c.kind !== 'remove') plan.added.push({ uid: c.uid, at });
      if (c.kind !== 'add') {
        plan.removed.push({ kind: 'furniture', item: c.item, at, seeds: matrixEffectSeeds() });
        end += MATRIX_EFFECT_DURATION_SEC;
      }
    }
    plan.duration = Math.max(plan.duration, end);
  });
  return plan;
}

/** How many of the plan's changes have started by `elapsed`. */
export function changesStarted(plan: BuildoutPlan, elapsed: number): number {
  let n = 0;
  while (n < plan.times.length && plan.times[n] <= elapsed) n++;
  return n;
}

/** What the office shows `elapsed` seconds into the Buildout. */
export function buildoutFrame(plan: BuildoutPlan, elapsed: number): BuildoutFrame {
  const { before, after } = plan;
  const n = after.tiles.length;
  // A per-tile array either side has, as the new one (absent = all null).
  const merged = <T>(now?: Array<T | null>, was?: Array<T | null>): Array<T | null> | undefined =>
    now ? [...now] : was ? new Array<T | null>(n).fill(null) : undefined;
  const tiles = [...after.tiles];
  const tileColors = merged(after.tileColors, before.tileColors);
  const wallSets = merged(after.wallSets, before.wallSets);
  const carpetTiles = merged(after.carpetTiles, before.carpetTiles);
  for (const { index, at } of plan.tiles) {
    if (at <= elapsed) continue;
    tiles[index] = before.tiles[index];
    if (tileColors) tileColors[index] = before.tileColors?.[index] ?? null;
    if (wallSets) wallSets[index] = before.wallSets?.[index] ?? null;
    if (carpetTiles) carpetTiles[index] = before.carpetTiles?.[index] ?? null;
  }
  const pending = new Set(plan.added.filter((a) => a.at > elapsed).map((a) => a.uid));
  const furniture = after.furniture.filter((f) => !pending.has(f.uid));
  for (const r of plan.removed) {
    if (r.at > elapsed && r.kind === 'furniture') furniture.push(r.item);
  }
  return {
    layout: { ...after, tiles, tileColors, wallSets, carpetTiles, furniture },
    dissolving: dissolvingAt(plan, elapsed),
  };
}

/** The removals dissolving `elapsed` seconds into the Buildout (the layout
 *  shown changes only as a change starts; the rain moves every frame). */
export function dissolvingAt(plan: BuildoutPlan, elapsed: number): BuildoutFrame['dissolving'] {
  const dissolving: BuildoutFrame['dissolving'] = [];
  for (const r of plan.removed) {
    if (r.at <= elapsed && elapsed < r.at + MATRIX_EFFECT_DURATION_SEC) {
      dissolving.push({ ...r, timer: elapsed - r.at });
    }
  }
  return dissolving;
}
