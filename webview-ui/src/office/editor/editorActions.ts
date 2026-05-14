import type { ColorValue } from "../../components/ui/types.js";
import { DEFAULT_NEUTRAL_COLOR } from "../../constants.js";
import {
  getCatalogEntry,
  getRotatedType,
  getToggledType,
} from "../layout/furnitureCatalog.js";
import { getPlacementBlockedTiles } from "../layout/layoutSerializer.js";
import type {
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from "../types.js";
import { MAX_COLS, MAX_ROWS, TileType } from "../types.js";

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

  const existingColors =
    layout.tileColors || new Array(layout.tiles.length).fill(null);
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
  return { ...layout, tiles, tileColors };
}

/** Place furniture. Returns new layout (immutable). */
export function placeFurniture(
  layout: OfficeLayout,
  item: PlacedFurniture,
): OfficeLayout {
  if (!canPlaceFurniture(layout, item.type, item.col, item.row)) return layout;
  return { ...layout, furniture: [...layout.furniture, item] };
}

/** Remove furniture by uid. Returns new layout (immutable). */
export function removeFurniture(
  layout: OfficeLayout,
  uid: string,
): OfficeLayout {
  const filtered = layout.furniture.filter((f) => f.uid !== uid);
  if (filtered.length === layout.furniture.length) return layout;
  return { ...layout, furniture: filtered };
}

/** Move furniture to new position. Returns new layout (immutable). */
export function moveFurniture(
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  if (!canPlaceFurniture(layout, item.type, newCol, newRow, uid)) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) =>
      f.uid === uid ? { ...f, col: newCol, row: newRow } : f,
    ),
  };
}

/** Rotate furniture to the next orientation. Returns new layout (immutable). */
export function rotateFurniture(
  layout: OfficeLayout,
  uid: string,
  direction: "cw" | "ccw",
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  const newType = getRotatedType(item.type, direction);
  if (!newType) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) =>
      f.uid === uid ? { ...f, type: newType } : f,
    ),
  };
}

/** Toggle furniture state (on/off). Returns new layout (immutable). */
export function toggleFurnitureState(
  layout: OfficeLayout,
  uid: string,
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  const newType = getToggledType(item.type);
  if (!newType) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) =>
      f.uid === uid ? { ...f, type: newType } : f,
    ),
  };
}

/** For wall items, offset the row so the bottom row aligns with the hovered tile. */
export function getWallPlacementRow(type: string, row: number): number {
  const entry = getCatalogEntry(type);
  if (!entry?.canPlaceOnWalls) return row;
  return row - (entry.footprintH - 1);
}

/** Check if furniture can be placed at (col, row) without overlapping. */
export function canPlaceFurniture(
  layout: OfficeLayout,
  type: string, // FurnitureType enum or asset ID
  col: number,
  row: number,
  excludeUid?: string,
): boolean {
  const entry = getCatalogEntry(type);
  if (!entry) return false;

  // Check bounds — wall items may extend above the map (top rows hang above the wall)
  if (entry.canPlaceOnWalls) {
    const bottomRow = row + entry.footprintH - 1;
    if (
      col < 0 ||
      col + entry.footprintW > layout.cols ||
      bottomRow < 0 ||
      bottomRow >= layout.rows
    ) {
      return false;
    }
  } else {
    if (
      col < 0 ||
      row < 0 ||
      col + entry.footprintW > layout.cols ||
      row + entry.footprintH > layout.rows
    ) {
      return false;
    }
  }

  // Wall/VOID placement check (background rows skip this check)
  const bgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < bgRows) continue;
    if (row + dr < 0) continue; // row above map (wall items extending upward)
    // Wall items: only the bottom row must be on wall tiles; upper rows can overlap VOID/anything
    if (entry.canPlaceOnWalls && dr < entry.footprintH - 1) continue;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const idx = (row + dr) * layout.cols + (col + dc);
      const tileVal = layout.tiles[idx];
      if (entry.canPlaceOnWalls) {
        if (tileVal !== TileType.WALL) return false;
      } else {
        if (tileVal === TileType.VOID) return false; // Cannot place on VOID
        if (tileVal === TileType.WALL) return false; // Normal items cannot overlap walls
      }
    }
  }

  // Build occupied set excluding the item being moved, skipping background tile rows
  const occupied = getPlacementBlockedTiles(layout.furniture, excludeUid);

  // If this item can be placed on surfaces, build set of desk tiles to exclude from collision
  let deskTiles: Set<string> | null = null;
  if (entry.canPlaceOnSurfaces) {
    deskTiles = new Set<string>();
    for (const item of layout.furniture) {
      if (item.uid === excludeUid) continue;
      const itemEntry = getCatalogEntry(item.type);
      if (!itemEntry || !itemEntry.isDesk) continue;
      for (let dr = 0; dr < itemEntry.footprintH; dr++) {
        for (let dc = 0; dc < itemEntry.footprintW; dc++) {
          deskTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
  }

  // Check overlap — also skip the NEW item's own background rows
  const newBgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < newBgRows) continue; // new item's background rows can overlap existing items
    if (row + dr < 0) continue; // row above map (wall items extending upward)
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const key = `${col + dc},${row + dr}`;
      if (occupied.has(key) && !deskTiles?.has(key)) return false;
    }
  }

  return true;
}

export type ExpandDirection = "left" | "right" | "up" | "down";

/**
 * Expand layout by 1 tile in the given direction. New tiles are VOID.
 * Furniture and tile indices are shifted when expanding left or up.
 * Returns { layout, shift } or null if exceeding MAX_COLS/MAX_ROWS.
 */
export function expandLayout(
  layout: OfficeLayout,
  direction: ExpandDirection,
): { layout: OfficeLayout; shift: { col: number; row: number } } | null {
  const { cols, rows, tiles, furniture, tileColors } = layout;
  const existingColors = tileColors || new Array(tiles.length).fill(null);

  let newCols = cols;
  let newRows = rows;
  let shiftCol = 0;
  let shiftRow = 0;

  if (direction === "right") {
    newCols = cols + 1;
  } else if (direction === "left") {
    newCols = cols + 1;
    shiftCol = 1;
  } else if (direction === "down") {
    newRows = rows + 1;
  } else if (direction === "up") {
    newRows = rows + 1;
    shiftRow = 1;
  }

  if (newCols > MAX_COLS || newRows > MAX_ROWS) return null;

  // Build new tile array
  const newTiles: TileTypeVal[] = new Array(newCols * newRows).fill(
    TileType.VOID as TileTypeVal,
  );
  const newColors: Array<ColorValue | null> = new Array(newCols * newRows).fill(
    null,
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const oldIdx = r * cols + c;
      const newIdx = (r + shiftRow) * newCols + (c + shiftCol);
      newTiles[newIdx] = tiles[oldIdx];
      newColors[newIdx] = existingColors[oldIdx];
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
    },
    shift: { col: shiftCol, row: shiftRow },
  };
}
