/**
 * Carpets and Areas: painting and erasing their tiles, adding, removing,
 * renaming and recolouring Areas.
 * Pure: each returns a new layout (or the same one when nothing changes).
 */

import type { AreaDefinition, CarpetTile, ColorValue, OfficeLayout } from '../types.js';
import { TileType } from '../types.js';

/** Whether an area stroke starting on (col, row) erases: it does when that tile already carries `label`. */
export function areaStrokeErases(
  layout: OfficeLayout,
  col: number,
  row: number,
  label: string,
): boolean {
  return (layout.areaTiles?.[row * layout.cols + col] ?? null) === label;
}

/**
 * Paint a carpet tile. Walls / VOID are not paintable. Order auto-increments
 * past every existing carpet so the new stroke wins at junctions (matches the
 * "last-painted carpet has priority" semantic from feat/zoning).
 * Returns new layout (immutable). No-op if (col, row) is out of bounds or the
 * underlying tile is non-paintable.
 */
export function paintCarpet(
  layout: OfficeLayout,
  col: number,
  row: number,
  variant: number,
  color?: ColorValue,
  accentColor?: ColorValue,
  order?: number,
): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  const tileVal = layout.tiles[idx];
  if (tileVal === TileType.VOID || tileVal === TileType.WALL) return layout;

  const existing =
    layout.carpetTiles ?? new Array<CarpetTile | null>(layout.tiles.length).fill(null);
  let maxOrder = 0;
  for (const c of existing) {
    if (c && typeof c.order === 'number' && c.order > maxOrder) maxOrder = c.order;
  }
  const nextOrder = order ?? maxOrder + 1;

  const newTile: CarpetTile = { variant, order: nextOrder };
  if (color !== undefined) newTile.color = { ...color };
  if (accentColor !== undefined) newTile.accentColor = { ...accentColor };

  const carpetTiles = [...existing];
  carpetTiles[idx] = newTile;
  return { ...layout, carpetTiles };
}

/** Remove the carpet on (col, row). Returns new layout (immutable). No-op if no carpet. */
export function eraseCarpet(layout: OfficeLayout, col: number, row: number): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  if (!layout.carpetTiles || (layout.carpetTiles[idx] ?? null) === null) return layout;
  const carpetTiles = [...layout.carpetTiles];
  carpetTiles[idx] = null;
  return { ...layout, carpetTiles };
}

/**
 * Paint an area label onto (col, row). Walls / VOID are not paintable. The
 * area must already exist in `layout.areas`. Returns new layout (immutable).
 */
export function paintArea(
  layout: OfficeLayout,
  col: number,
  row: number,
  areaLabel: string,
): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  const tileVal = layout.tiles[idx];
  if (tileVal === TileType.VOID || tileVal === TileType.WALL) return layout;
  if (!(layout.areas ?? []).some((a) => a.label === areaLabel)) return layout;

  const areaTiles = layout.areaTiles
    ? [...layout.areaTiles]
    : new Array<string | null>(layout.tiles.length).fill(null);
  if (areaTiles[idx] === areaLabel) return layout;
  areaTiles[idx] = areaLabel;
  return { ...layout, areaTiles };
}

/** Clear the area label on (col, row). Returns new layout (immutable). No-op if untagged. */
export function eraseArea(layout: OfficeLayout, col: number, row: number): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  if (!layout.areaTiles || (layout.areaTiles[idx] ?? null) === null) return layout;
  const areaTiles = [...layout.areaTiles];
  areaTiles[idx] = null;
  return { ...layout, areaTiles };
}

/** Add a new Area definition. No-op on empty label or duplicate. */
export function addArea(layout: OfficeLayout, label: string, color: string): OfficeLayout {
  const trimmed = label.trim();
  if (!trimmed) return layout;
  const existing = layout.areas ?? [];
  if (existing.some((a) => a.label === trimmed)) return layout;
  const areas: AreaDefinition[] = [...existing, { label: trimmed, color }];
  return { ...layout, areas };
}

/**
 * Remove an Area + clear every tile labeled with it. Returns new layout
 * (immutable). No-op if the area doesn't exist.
 */
export function removeArea(layout: OfficeLayout, label: string): OfficeLayout {
  const existing = layout.areas ?? [];
  if (!existing.some((a) => a.label === label)) return layout;
  const areas = existing.filter((a) => a.label !== label);
  let areaTiles = layout.areaTiles;
  if (areaTiles && areaTiles.some((t) => t === label)) {
    areaTiles = areaTiles.map((t) => (t === label ? null : t));
  }
  return { ...layout, areas, areaTiles };
}

/**
 * Rename an Area + rewrite every tile labeled with the old name. No-op when
 * the new name is empty, equals the old name, or collides with another area.
 */
export function renameArea(layout: OfficeLayout, oldLabel: string, newLabel: string): OfficeLayout {
  const trimmed = newLabel.trim();
  if (!trimmed || trimmed === oldLabel) return layout;
  const existing = layout.areas ?? [];
  if (!existing.some((a) => a.label === oldLabel)) return layout;
  if (existing.some((a) => a.label === trimmed)) return layout;
  const areas = existing.map((a) => (a.label === oldLabel ? { ...a, label: trimmed } : a));
  let areaTiles = layout.areaTiles;
  if (areaTiles && areaTiles.some((t) => t === oldLabel)) {
    areaTiles = areaTiles.map((t) => (t === oldLabel ? trimmed : t));
  }
  return { ...layout, areas, areaTiles };
}

/** Update an Area's display color. No-op if the area doesn't exist or color is unchanged. */
export function updateAreaColor(layout: OfficeLayout, label: string, color: string): OfficeLayout {
  const existing = layout.areas ?? [];
  const idx = existing.findIndex((a) => a.label === label);
  if (idx === -1) return layout;
  if (existing[idx].color === color) return layout;
  const areas = existing.map((a, i) => (i === idx ? { ...a, color } : a));
  return { ...layout, areas };
}
