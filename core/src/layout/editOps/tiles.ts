/**
 * Tile edits: floor painting, walls and their wall sets, wall-tool strokes, and
 * the erase tool's tile (which also deletes the furniture it passes through).
 * Pure: each returns a new layout (or the same one when nothing changes).
 */

import type { FurnitureCatalog } from '../catalog.js';
import { DEFAULT_NEUTRAL_COLOR } from '../constants.js';
import type { ColorValue, OfficeLayout, TileType as TileTypeVal } from '../types.js';
import { TileType } from '../types.js';
import { removeFurnitureAt } from './furniture.js';

/** Paint a single tile with pattern and color. Returns new layout (immutable). */
export function paintTile(
  layout: OfficeLayout,
  col: number,
  row: number,
  tileType: TileTypeVal,
  color?: ColorValue,
): OfficeLayout {
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;

  const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null);
  const newColor =
    color ??
    (tileType === TileType.WALL || tileType === TileType.VOID
      ? null
      : { ...DEFAULT_NEUTRAL_COLOR });

  // Check if anything actually changed
  if (layout.tiles[idx] === tileType) {
    const existingColor = existingColors[idx];
    if (newColor === null && existingColor === null) return layout;
    if (
      newColor &&
      existingColor &&
      newColor.h === existingColor.h &&
      newColor.s === existingColor.s &&
      newColor.b === existingColor.b &&
      newColor.c === existingColor.c &&
      !!newColor.colorize === !!existingColor.colorize
    )
      return layout;
  }

  const tiles = [...layout.tiles];
  tiles[idx] = tileType;
  const tileColors = [...existingColors];
  tileColors[idx] = newColor;
  // A tile that stops being a wall drops its wall set.
  if (layout.wallSets && (layout.wallSets[idx] ?? null) !== null && tileType !== TileType.WALL) {
    const wallSets = [...layout.wallSets];
    wallSets[idx] = null;
    return { ...layout, tiles, tileColors, wallSets };
  }
  return { ...layout, tiles, tileColors };
}

/** The set a wall tile wears (set 0 when the layout records none). */
export function wallSetOf(layout: OfficeLayout, idx: number): number {
  return layout.wallSets?.[idx] ?? 0;
}

/** Whether (col, row) is a wall of this set and colour. */
export function isWallLike(
  layout: OfficeLayout,
  col: number,
  row: number,
  set: number,
  color: ColorValue,
): boolean {
  const idx = row * layout.cols + col;
  if (layout.tiles[idx] !== TileType.WALL || wallSetOf(layout, idx) !== set) return false;
  const c = layout.tileColors?.[idx];
  return !!c && c.h === color.h && c.s === color.s && c.b === color.b && c.c === color.c;
}

/**
 * Paint a wall of `set` in `color` on (col, row) — a new wall, or a restyled
 * one. Returns new layout (immutable); unchanged when it already is one.
 */
export function paintWall(
  layout: OfficeLayout,
  col: number,
  row: number,
  set: number,
  color: ColorValue,
): OfficeLayout {
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  if (isWallLike(layout, col, row, set, color)) return layout;
  const painted = paintTile(layout, col, row, TileType.WALL, color);
  if (wallSetOf(painted, idx) === set) return painted;
  const wallSets = painted.wallSets
    ? [...painted.wallSets]
    : new Array<number | null>(painted.tiles.length).fill(null);
  wallSets[idx] = set;
  return { ...painted, wallSets };
}

/**
 * One tile of an erase stroke: clear it to VOID and delete any furniture it
 * passes through. Returns new layout (immutable); unchanged when the tile is
 * out of bounds or already bare VOID.
 */
export function eraseTile(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  col: number,
  row: number,
): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  const cleared =
    layout.tiles[idx] === TileType.VOID ? layout : paintTile(layout, col, row, TileType.VOID);
  return removeFurnitureAt(catalog, cleared, col, row);
}

/** Whether (col, row) is on the grid and neither VOID nor wall — where carpets and areas go. */
export function isFloorTile(layout: OfficeLayout, col: number, row: number): boolean {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return false;
  const tileVal = layout.tiles[row * layout.cols + col];
  return tileVal !== TileType.VOID && tileVal !== TileType.WALL;
}

/**
 * One tile of a wall-tool stroke. The stroke's first tile decides its
 * direction (`adding`): adding paints the wall (`set` in `color`) over
 * anything, restyling walls of another set or colour; removing turns a wall
 * back into floor of the given pattern and colour and leaves non-walls alone.
 * Returns new layout (immutable).
 */
export function wallStrokeTile(
  layout: OfficeLayout,
  col: number,
  row: number,
  adding: boolean,
  wall: { set: number; color: ColorValue },
  floor: { type: TileTypeVal; color: ColorValue },
): OfficeLayout {
  if (adding) return paintWall(layout, col, row, wall.set, wall.color);
  if (layout.tiles[row * layout.cols + col] !== TileType.WALL) return layout;
  return paintTile(layout, col, row, floor.type, floor.color);
}

/**
 * Whether a wall stroke starting on (col, row) adds walls. It removes them
 * only when it starts on the very wall it would paint (same set and colour),
 * so clicking a wall toggles it, and dragging from a different wall restyles.
 */
export function wallStrokeAdds(
  layout: OfficeLayout,
  col: number,
  row: number,
  wall: { set: number; color: ColorValue },
): boolean {
  return !isWallLike(layout, col, row, wall.set, wall.color);
}
