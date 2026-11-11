/**
 * Where a seat is: its tile and the Area that tile belongs to, by core's layout
 * model — the same seats the office derives (layoutToSeats), so the server and
 * every office agree on them.
 */

import {
  type CatalogSource,
  createFurnitureCatalog,
  type FurnitureCatalog,
  layoutToSeats,
  type OfficeLayout,
} from '../../../core/src/layout/index.js';

export interface SeatPlace {
  tile: { col: number; row: number };
  /** The label of the Area holding the tile, or null. */
  area: string | null;
}

const catalogs = new WeakMap<readonly CatalogSource[], FurnitureCatalog | null>();

/** The catalogue built from catalogue data, once per data array. */
export function catalogOf(data: readonly CatalogSource[]): FurnitureCatalog | null {
  if (data.length === 0) return null;
  let catalog = catalogs.get(data);
  if (catalog === undefined) {
    catalog = createFurnitureCatalog(data);
    catalogs.set(data, catalog);
  }
  return catalog;
}

/** Every seat of the layout, by seat id. */
export function seatsOf(
  layout: OfficeLayout | null,
  catalog: FurnitureCatalog | null,
): Map<string, SeatPlace> {
  const places = new Map<string, SeatPlace>();
  if (!layout || !catalog) return places;
  for (const [id, seat] of layoutToSeats(catalog, layout.furniture)) {
    const tile = { col: seat.seatCol, row: seat.seatRow };
    places.set(id, { tile, area: areaAt(layout, tile) });
  }
  return places;
}

/** The label of the Area holding a tile, or null. */
export function areaAt(layout: OfficeLayout, tile: { col: number; row: number }): string | null {
  return layout.areaTiles?.[tile.row * layout.cols + tile.col] ?? null;
}
