/**
 * Grid edits: expanding and shrinking the layout by a row or column.
 * Pure: each returns a new layout (or the same one when nothing changes).
 */

import type { FurnitureCatalog } from '../catalog.js';
import { catalogEntry } from '../catalog.js';
import { MAX_COLS, MAX_ROWS } from '../constants.js';
import type {
  CarpetTile,
  ColorValue,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../types.js';
import { TileType } from '../types.js';

export type ExpandDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Expand layout by 1 tile in the given direction. New tiles are VOID.
 * Furniture and tile indices are shifted when expanding left or up.
 * Returns { layout, shift } or null if exceeding MAX_COLS/MAX_ROWS.
 */
export function expandLayout(
  layout: OfficeLayout,
  direction: ExpandDirection,
): { layout: OfficeLayout; shift: { col: number; row: number } } | null {
  const { cols, rows, tiles, furniture, tileColors, carpetTiles, areaTiles, wallSets } = layout;
  const existingColors = tileColors || new Array(tiles.length).fill(null);

  let newCols = cols;
  let newRows = rows;
  let shiftCol = 0;
  let shiftRow = 0;

  if (direction === 'right') {
    newCols = cols + 1;
  } else if (direction === 'left') {
    newCols = cols + 1;
    shiftCol = 1;
  } else if (direction === 'down') {
    newRows = rows + 1;
  } else if (direction === 'up') {
    newRows = rows + 1;
    shiftRow = 1;
  }

  if (newCols > MAX_COLS || newRows > MAX_ROWS) return null;

  // Build new tile array
  const newSize = newCols * newRows;
  const newTiles: TileTypeVal[] = new Array(newSize).fill(TileType.VOID as TileTypeVal);
  const newColors: Array<ColorValue | null> = new Array(newSize).fill(null);
  const newCarpetTiles: Array<CarpetTile | null> | undefined = carpetTiles
    ? new Array<CarpetTile | null>(newSize).fill(null)
    : undefined;
  const newAreaTiles: Array<string | null> | undefined = areaTiles
    ? new Array<string | null>(newSize).fill(null)
    : undefined;
  const newWallSets: Array<number | null> | undefined = wallSets
    ? new Array<number | null>(newSize).fill(null)
    : undefined;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const oldIdx = r * cols + c;
      const newIdx = (r + shiftRow) * newCols + (c + shiftCol);
      newTiles[newIdx] = tiles[oldIdx];
      newColors[newIdx] = existingColors[oldIdx];
      if (newCarpetTiles && carpetTiles) {
        newCarpetTiles[newIdx] = carpetTiles[oldIdx] ?? null;
      }
      if (newAreaTiles && areaTiles) {
        newAreaTiles[newIdx] = areaTiles[oldIdx] ?? null;
      }
      if (newWallSets && wallSets) {
        newWallSets[newIdx] = wallSets[oldIdx] ?? null;
      }
    }
  }

  // Shift furniture positions
  const newFurniture: PlacedFurniture[] = furniture.map((f) => ({
    ...f,
    col: f.col + shiftCol,
    row: f.row + shiftRow,
  }));

  return {
    layout: {
      ...layout,
      cols: newCols,
      rows: newRows,
      tiles: newTiles,
      tileColors: newColors,
      furniture: newFurniture,
      ...(newCarpetTiles ? { carpetTiles: newCarpetTiles } : {}),
      ...(newAreaTiles ? { areaTiles: newAreaTiles } : {}),
      ...(newWallSets ? { wallSets: newWallSets } : {}),
    },
    shift: { col: shiftCol, row: shiftRow },
  };
}

/**
 * Remove one edge row or column. Only an EMPTY edge goes: every tile on it is
 * VOID and no item is left outside the grid by the cut (an item's solid rows
 * never stand on VOID anyway; a wall item may keep hanging above the top edge
 * as long as its bottom row stays inside). Furniture shifts with the grid when
 * the cut is on the left or top. Null when the edge isn't empty or the grid
 * would be left without a row or column.
 */
export function shrinkLayout(
  catalog: FurnitureCatalog,
  layout: OfficeLayout,
  direction: ExpandDirection,
): { layout: OfficeLayout; shift: { col: number; row: number } } | null {
  const { cols, rows } = layout;
  const horizontal = direction === 'left' || direction === 'right';
  if (horizontal ? cols <= 1 : rows <= 1) return null;
  const edgeCol = direction === 'left' ? 0 : direction === 'right' ? cols - 1 : -1;
  const edgeRow = direction === 'up' ? 0 : direction === 'down' ? rows - 1 : -1;
  for (let i = 0; i < layout.tiles.length; i++) {
    const onEdge = horizontal ? i % cols === edgeCol : Math.floor(i / cols) === edgeRow;
    if (onEdge && layout.tiles[i] !== TileType.VOID) return null;
  }

  const newCols = horizontal ? cols - 1 : cols;
  const newRows = horizontal ? rows : rows - 1;
  const shiftCol = direction === 'left' ? -1 : 0;
  const shiftRow = direction === 'up' ? -1 : 0;
  const keep = (idx: number): boolean =>
    horizontal ? idx % cols !== edgeCol : Math.floor(idx / cols) !== edgeRow;
  const cut = <T>(arr: T[] | undefined): T[] | undefined => arr?.filter((_, i) => keep(i));

  const furniture = layout.furniture.map((f) => ({
    ...f,
    col: f.col + shiftCol,
    row: f.row + shiftRow,
  }));
  for (const f of furniture) {
    const entry = catalogEntry(catalog, f.type);
    if (!entry) continue;
    const top = entry.canPlaceOnWalls ? f.row + entry.footprintH - 1 : f.row;
    if (f.col < 0 || top < 0) return null;
    if (f.col + entry.footprintW > newCols || f.row + entry.footprintH > newRows) return null;
  }

  const shrunk: OfficeLayout = {
    ...layout,
    cols: newCols,
    rows: newRows,
    tiles: cut(layout.tiles)!,
    furniture,
  };
  if (layout.tileColors) shrunk.tileColors = cut(layout.tileColors);
  if (layout.carpetTiles) shrunk.carpetTiles = cut(layout.carpetTiles);
  if (layout.areaTiles) shrunk.areaTiles = cut(layout.areaTiles);
  if (layout.wallSets) shrunk.wallSets = cut(layout.wallSets);
  return { layout: shrunk, shift: { col: shiftCol, row: shiftRow } };
}
