/**
 * Where a piece's new panel may open (a PC: its new PC shell): the Directories
 * mapped to the Area the piece stands in. One reading for every reader — the
 * office (the click's places, so the rules can offer the Directory selector)
 * and the server (the folder an open resolves to, and the check on a named
 * Directory) — so the selector never lists a Directory the server refuses.
 *
 * Pure, over core's layout model; it knows no furniture by name.
 */

import type { FurnitureCatalog, OfficeLayout, PlacedFurniture } from '../layout/index.js';
import { footprintTiles } from '../layout/index.js';

/** The Area a placed piece stands in: the first of its footprint's tiles that has one, else null. */
export function pieceArea(
  layout: OfficeLayout,
  catalog: FurnitureCatalog,
  piece: PlacedFurniture,
): string | null {
  const tiles = layout.areaTiles;
  if (!tiles || tiles.length === 0) return null;
  for (const { col, row } of footprintTiles(catalog, piece)) {
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) continue;
    const label = tiles[row * layout.cols + col];
    if (label) return label;
  }
  return null;
}

/**
 * The Directories mapped to `area` (config `areaMappings`: Directory name → its
 * Area labels), in the given order, each name once. None without an Area.
 */
export function areaDirectories<D extends { name: string }>(
  area: string | null,
  directories: readonly D[],
  areaMappings: Readonly<Record<string, readonly string[]>>,
): D[] {
  if (area === null) return [];
  const seen = new Set<string>();
  return directories.filter((d) => {
    if (seen.has(d.name) || !areaMappings[d.name]?.includes(area)) return false;
    seen.add(d.name);
    return true;
  });
}
