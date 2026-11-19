import { wallSetOf } from './editOps.js';
import type { ColorValue, OfficeLayout, TileType as TileTypeVal } from './types.js';
import { TileType } from './types.js';

/**
 * Sections: a run of touching tiles (edge to edge) of one material — floors of
 * the same pattern and colour, or walls of the same set and colour. The
 * Floor and Walls panels' Select tool picks sections, and while some are
 * picked the panel's sliders and thumbnails restyle all of them at once.
 */
export type SectionKind = 'floor' | 'wall';

/** How a section is restyled: the floor's pattern, or the wall's set, plus the colour. */
export type SectionStyle =
  | { kind: 'floor'; tileType: TileTypeVal; color: ColorValue }
  | { kind: 'wall'; set: number; color: ColorValue };

function sameColor(a: ColorValue | null | undefined, b: ColorValue | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.h === b.h && a.s === b.s && a.b === b.b && a.c === b.c && !!a.colorize === !!b.colorize;
}

/** Whether a tile is floor or wall (null for VOID or off the grid). */
export function sectionKindAt(layout: OfficeLayout, idx: number): SectionKind | null {
  const tile = layout.tiles[idx];
  if (tile === undefined || tile === TileType.VOID) return null;
  return tile === TileType.WALL ? 'wall' : 'floor';
}

/**
 * The section (col, row) belongs to, as tile indices in ascending order:
 * every tile reachable through edge neighbours of the same material. Empty
 * for VOID or a tile off the grid.
 */
export function sectionAt(layout: OfficeLayout, col: number, row: number): number[] {
  const { cols, rows } = layout;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return [];
  const start = row * cols + col;
  if (sectionKindAt(layout, start) === null) return [];

  const tile = layout.tiles[start];
  const color = layout.tileColors?.[start];
  const set = wallSetOf(layout, start);
  const matches = (idx: number) =>
    layout.tiles[idx] === tile &&
    sameColor(layout.tileColors?.[idx], color) &&
    (tile !== TileType.WALL || wallSetOf(layout, idx) === set);

  const seen = new Uint8Array(cols * rows);
  const queue = [start];
  seen[start] = 1;
  for (let i = 0; i < queue.length; i++) {
    const idx = queue[i];
    const c = idx % cols;
    const r = (idx - c) / cols;
    const neighbours = [
      c > 0 ? idx - 1 : -1,
      c < cols - 1 ? idx + 1 : -1,
      r > 0 ? idx - cols : -1,
      r < rows - 1 ? idx + cols : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || seen[n] || !matches(n)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return queue.sort((a, b) => a - b);
}

/**
 * Restyle every tile of `tiles` in one edit: floors take the pattern and
 * colour, walls the set and colour. Tiles that aren't of the style's kind are
 * left alone. Returns the same layout when nothing changes.
 */
export function restyleSection(
  layout: OfficeLayout,
  tiles: readonly number[],
  style: SectionStyle,
): OfficeLayout {
  let tileArr: TileTypeVal[] | null = null;
  let colors: Array<ColorValue | null> | null = null;
  let sets: Array<number | null> | null = null;

  for (const idx of tiles) {
    if (sectionKindAt(layout, idx) !== style.kind) continue;
    if (!sameColor(layout.tileColors?.[idx], style.color)) {
      colors ??= layout.tileColors
        ? [...layout.tileColors]
        : new Array<ColorValue | null>(layout.tiles.length).fill(null);
      colors[idx] = { ...style.color };
    }
    if (style.kind === 'floor') {
      if (layout.tiles[idx] !== style.tileType) {
        tileArr ??= [...layout.tiles];
        tileArr[idx] = style.tileType;
      }
    } else if (wallSetOf(layout, idx) !== style.set) {
      sets ??= layout.wallSets
        ? [...layout.wallSets]
        : new Array<number | null>(layout.tiles.length).fill(null);
      sets[idx] = style.set === 0 ? null : style.set;
    }
  }

  if (!tileArr && !colors && !sets) return layout;
  return {
    ...layout,
    ...(tileArr && { tiles: tileArr }),
    ...(colors && { tileColors: colors }),
    ...(sets && { wallSets: sets }),
  };
}

/** The style a section's tile wears now, to seed the panel's brush with. */
export function sectionStyleAt(layout: OfficeLayout, idx: number): SectionStyle | null {
  const kind = sectionKindAt(layout, idx);
  const color = layout.tileColors?.[idx];
  if (!kind || !color) return null;
  return kind === 'wall'
    ? { kind, set: wallSetOf(layout, idx), color: { ...color } }
    : { kind, tileType: layout.tiles[idx], color: { ...color } };
}
