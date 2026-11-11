/**
 * How the Pixel Office MCP describes a layout and the catalogue to an agent
 * (get_layout, list_catalog): pure functions from the office's snapshot to the
 * agent-facing JSON (snake_case). The vocabulary here — rectangles, colours,
 * orientations, states, pattern / wall set / carpet / pet indices — is the one
 * edit_layout takes, so what an agent reads it can write back.
 */

import {
  catalogEntry,
  type CatalogItem,
  FURNITURE_CATEGORIES,
  type FurnitureCatalog,
  type FurnitureCategory,
  MAX_COLS,
  MAX_ROWS,
  type OfficeLayout,
  orientationInGroup,
  type PlacedFurniture,
  TileType,
  WALL_SET_LABELS,
} from '../../../core/src/layout/index.js';
import type { OfficeAssets, OfficeLayoutSnapshot, OfficeSeat } from './officeOperations.js';
import { areaAt } from './seatPlace.js';

/** A rectangle of tiles: its top-left tile and its size, in tiles. */
export interface TileRect {
  col: number;
  row: number;
  width: number;
  height: number;
}

/** The categories furniture comes in, in the editor's tab order. */
export const FURNITURE_CATEGORY_IDS = FURNITURE_CATEGORIES.map((c) => c.id) as [
  FurnitureCategory,
  ...FurnitureCategory[],
];

/** The highest floor pattern a tile can hold (TileType FLOOR_1..FLOOR_9). */
export const MAX_FLOOR_PATTERN = TileType.FLOOR_9;

// ── Map characters ───────────────────────────────────────────

const WALL_CHAR = '#';
const FLOOR_CHAR = '.';
const VOID_CHAR = '-';
/** Area letters, in the layout's Area order; past these an Area shows as AREA_OVERFLOW_CHAR. */
const AREA_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const AREA_OVERFLOW_CHAR = '?';

// ── Areas ────────────────────────────────────────────────────

/** colorName's cut-offs: below MIN_SATURATION (or MIN_CHROMA) a colour is a grey,
 *  named by its lightness; otherwise by the first hue band it falls under. */
const COLOR_NAME_MIN_SATURATION = 0.15;
const COLOR_NAME_MIN_CHROMA = 0.08;
const COLOR_NAME_BLACK_BELOW = 0.15;
const COLOR_NAME_WHITE_ABOVE = 0.85;
/** Light reds read as pink, dark oranges as brown. */
const COLOR_NAME_PINK_ABOVE = 0.7;
const COLOR_NAME_BROWN_BELOW = 0.35;
/** Hue bands (degrees, upper bound exclusive), red wrapping round past the last. */
const COLOR_NAME_HUES: ReadonlyArray<readonly [number, string]> = [
  [15, 'red'],
  [45, 'orange'],
  [70, 'yellow'],
  [165, 'green'],
  [195, 'cyan'],
  [255, 'blue'],
  [290, 'purple'],
  [345, 'pink'],
  [360, 'red'],
];

/** A plain name for an Area's `#rrggbb` colour ("blue"), so "the blue room" resolves. */
export function colorName(hex: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const light = (max + min) / 2;
  const sat = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * light - 1));
  if (sat < COLOR_NAME_MIN_SATURATION || chroma < COLOR_NAME_MIN_CHROMA) {
    if (light < COLOR_NAME_BLACK_BELOW) return 'black';
    if (light > COLOR_NAME_WHITE_ABOVE) return 'white';
    return 'gray';
  }
  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  const name = COLOR_NAME_HUES.find(([upper]) => hue < upper)?.[1] ?? 'red';
  if (name === 'red' && light > COLOR_NAME_PINK_ABOVE) return 'pink';
  if (name === 'orange' && light < COLOR_NAME_BROWN_BELOW) return 'brown';
  return name;
}

/** The layout's Area with this label, matched without regard to case. */
export function findArea(layout: OfficeLayout, label: string): string | null {
  const wanted = label.trim().toLowerCase();
  return (layout.areas ?? []).find((a) => a.label.toLowerCase() === wanted)?.label ?? null;
}

/** The tiles labelled with an Area, as their bounding box and count (null box when none). */
function areaExtent(layout: OfficeLayout, label: string): { box: TileRect | null; tiles: number } {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  let tiles = 0;
  const areaTiles = layout.areaTiles ?? [];
  for (let idx = 0; idx < areaTiles.length; idx++) {
    if (areaTiles[idx] !== label) continue;
    const col = idx % layout.cols;
    const row = Math.floor(idx / layout.cols);
    tiles++;
    minCol = Math.min(minCol, col);
    minRow = Math.min(minRow, row);
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, row);
  }
  const box =
    tiles === 0
      ? null
      : { col: minCol, row: minRow, width: maxCol - minCol + 1, height: maxRow - minRow + 1 };
  return { box, tiles };
}

// ── Summary ──────────────────────────────────────────────────

function freeSeatIds(seats: OfficeSeat[]): string[] {
  return seats.filter((s) => s.takenBy === null).map((s) => s.id);
}

/** A group of seats: how many, and the ids of the free ones (what launch_agent's seat takes). */
function seatTally(seats: OfficeSeat[]): { seats: number; free_seats: string[] } {
  return { seats: seats.length, free_seats: freeSeatIds(seats) };
}

/** get_layout's summary: grid, Areas, seats, furniture counts — never a per-item list. */
export function layoutSummary(snapshot: OfficeLayoutSnapshot): Record<string, unknown> {
  const { layout, catalog, seats } = snapshot;
  const tiles = { floor: 0, wall: 0, void: 0 };
  for (const t of layout.tiles) {
    if (t === TileType.WALL) tiles.wall++;
    else if (t === TileType.VOID) tiles.void++;
    else tiles.floor++;
  }

  const areas = (layout.areas ?? []).map((area, i) => {
    const { box, tiles: count } = areaExtent(layout, area.label);
    return {
      label: area.label,
      letter: AREA_LETTERS[i] ?? AREA_OVERFLOW_CHAR,
      color: area.color,
      color_name: colorName(area.color),
      bounds: box,
      tiles: count,
      directories: snapshot.areaDirectories.get(area.label) ?? [],
      ...seatTally(seats.filter((s) => s.area === area.label)),
    };
  });

  const furnitureCounts: Record<string, number> = {};
  for (const item of layout.furniture) {
    const category = (catalog && catalogEntry(catalog, item.type)?.category) || 'unknown';
    furnitureCounts[category] = (furnitureCounts[category] ?? 0) + 1;
  }

  const carpetTiles = (layout.carpetTiles ?? []).filter((c) => c).length;
  return {
    grid: { cols: layout.cols, rows: layout.rows, max_cols: MAX_COLS, max_rows: MAX_ROWS },
    tiles,
    areas,
    seats: {
      total: seats.length,
      free: freeSeatIds(seats).length,
      outside_areas: seatTally(seats.filter((s) => s.area === null)),
    },
    furniture_total: layout.furniture.length,
    furniture_counts: furnitureCounts,
    carpet_tiles: carpetTiles,
    pets: (layout.pets ?? []).length,
  };
}

/** The overlap of two rectangles, or null when they don't meet. */
function intersection(a: TileRect, b: TileRect): TileRect | null {
  const col = Math.max(a.col, b.col);
  const row = Math.max(a.row, b.row);
  const endCol = Math.min(a.col + a.width, b.col + b.width);
  const endRow = Math.min(a.row + a.height, b.row + b.height);
  if (endCol <= col || endRow <= row) return null;
  return { col, row, width: endCol - col, height: endRow - row };
}

// ── Furniture ────────────────────────────────────────────────

/** A placed item's on/off state, when its type has an on/off counterpart. */
function stateOf(catalog: FurnitureCatalog, type: string): 'on' | 'off' | null {
  if (catalog.offToOn.has(type)) return 'off';
  if (catalog.stateGroups.has(type)) return 'on';
  return null;
}

/** An entry's orientation in edit_layout's names (front / back / left / right). */
function orientationOf(catalog: FurnitureCatalog, entry: CatalogItem): string | null {
  const inGroup = orientationInGroup(catalog, entry.type);
  if (inGroup) return inGroup;
  if (!entry.orientation) return null;
  return entry.orientation === 'side' ? 'right' : entry.orientation;
}

/** The Area an item stands in: the one holding most of its footprint (for a wall
 *  item, the floor row just below it — Areas never cover walls). */
function areaOfItem(
  layout: OfficeLayout,
  item: PlacedFurniture,
  entry: CatalogItem | undefined,
): string | null {
  const w = entry?.footprintW ?? 1;
  const h = entry?.footprintH ?? 1;
  const rows = entry?.canPlaceOnWalls
    ? [item.row + h]
    : Array.from({ length: h }, (_, i) => item.row + i);
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (let col = item.col; col < item.col + w; col++) {
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) continue;
      const label = areaAt(layout, { col, row });
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) [best, bestCount] = [label, count];
  }
  return best;
}

export interface FurnitureFilter {
  /** An Area label (as the layout spells it). */
  area?: string;
  category?: FurnitureCategory;
  rect?: TileRect;
}

/** get_layout's furniture level: every placed item matching the filter. */
export function furnitureItems(
  snapshot: OfficeLayoutSnapshot,
  filter: FurnitureFilter,
): Array<Record<string, unknown>> {
  const { layout, catalog } = snapshot;
  const items: Array<Record<string, unknown>> = [];
  for (const item of layout.furniture) {
    const entry = catalog ? catalogEntry(catalog, item.type) : undefined;
    const footprint = { width: entry?.footprintW ?? 1, height: entry?.footprintH ?? 1 };
    const area = areaOfItem(layout, item, entry);
    if (filter.area !== undefined && area !== filter.area) continue;
    if (filter.category !== undefined && entry?.category !== filter.category) continue;
    if (filter.rect && !intersection({ col: item.col, row: item.row, ...footprint }, filter.rect))
      continue;
    items.push({
      uid: item.uid,
      type: item.type,
      label: entry?.label ?? null,
      category: entry?.category ?? null,
      col: item.col,
      row: item.row,
      footprint,
      orientation: catalog && entry ? orientationOf(catalog, entry) : null,
      state: catalog ? stateOf(catalog, item.type) : null,
      color: item.color ?? null,
      area,
      ...(entry ? {} : { unknown_type: true }),
    });
  }
  return items;
}

// ── Tile map ─────────────────────────────────────────────────

/**
 * get_layout's tiles level: an ASCII map of the grid (cropped to the Area's
 * bounding box and/or `rect`, both when both are given), one string per row.
 * Null when the crop holds no tile.
 */
export function tileChart(
  layout: OfficeLayout,
  crop: { area?: string; rect?: TileRect },
): Record<string, unknown> | null {
  let box: TileRect | null = { col: 0, row: 0, width: layout.cols, height: layout.rows };
  if (crop.area !== undefined) {
    const areaBox = areaExtent(layout, crop.area).box;
    box = areaBox && intersection(box, areaBox);
  }
  if (box && crop.rect) box = intersection(box, crop.rect);
  if (!box) return null;

  const letters = new Map<string, string>();
  const legend: Record<string, string> = {
    [WALL_CHAR]: 'wall',
    [FLOOR_CHAR]: 'floor outside any Area',
    [VOID_CHAR]: 'void (no tile)',
  };
  (layout.areas ?? []).forEach((area, i) => {
    const letter = AREA_LETTERS[i] ?? AREA_OVERFLOW_CHAR;
    letters.set(area.label, letter);
    if (letter !== AREA_OVERFLOW_CHAR) legend[letter] = `floor in Area "${area.label}"`;
  });
  if ((layout.areas ?? []).length > AREA_LETTERS.length)
    legend[AREA_OVERFLOW_CHAR] = 'floor in an Area past the 52nd';

  const rows: string[] = [];
  for (let row = box.row; row < box.row + box.height; row++) {
    let line = '';
    for (let col = box.col; col < box.col + box.width; col++) {
      const idx = row * layout.cols + col;
      const tile = layout.tiles[idx];
      if (tile === TileType.WALL) line += WALL_CHAR;
      else if (tile === TileType.VOID || tile === undefined) line += VOID_CHAR;
      else {
        const area = areaAt(layout, { col, row });
        line += (area && letters.get(area)) || FLOOR_CHAR;
      }
    }
    rows.push(line);
  }
  let ruler = '';
  for (let col = box.col; col < box.col + box.width; col++) ruler += String(col % 10);
  return {
    origin: { col: box.col, row: box.row },
    width: box.width,
    height: box.height,
    legend,
    ruler,
    rows,
    how_to_read:
      "rows[i][j] is tile (col origin.col + j, row origin.row + i); ruler gives each column's last digit.",
  };
}

// ── Catalogue ────────────────────────────────────────────────

function footprintOf(entry: CatalogItem): { width: number; height: number } {
  return { width: entry.footprintW, height: entry.footprintH };
}

/** One placeable type's rules: what edit_layout checks before placing it. */
function placementOf(entry: CatalogItem): Record<string, unknown> {
  return {
    footprint: footprintOf(entry),
    background_rows: entry.backgroundTiles ?? 0,
    is_desk: entry.isDesk,
    can_place_on_surfaces: !!entry.canPlaceOnSurfaces,
    can_place_on_walls: !!entry.canPlaceOnWalls,
  };
}

/** A furniture group as list_catalog lists it: its palette entry, its rotations and states. */
function catalogGroup(catalog: FurnitureCatalog, entry: CatalogItem): Record<string, unknown> {
  const group = catalog.rotationGroups.get(entry.type);
  const onType = catalog.offToOn.get(entry.type);
  const described: Record<string, unknown> = {
    type: entry.type,
    label: entry.label,
    category: entry.category,
    ...placementOf(entry),
  };
  if (group) {
    described.orientations = group.orientations.map((orientation) => {
      const type = group.members[orientation];
      const variant = catalogEntry(catalog, type) ?? entry;
      const on = catalog.offToOn.get(type);
      return {
        orientation,
        type,
        ...placementOf(variant),
        ...(on ? { on_type: on } : {}),
      };
    });
  } else if (onType) {
    described.states = { off: entry.type, on: onType };
  }
  return described;
}

/** list_catalog: furniture (optionally one category) and every look a tile, carpet or pet takes. */
export function catalogListing(
  assets: OfficeAssets,
  category: FurnitureCategory | undefined,
): Record<string, unknown> {
  const { catalog } = assets;
  const furniture = catalog
    ? catalog.visible
        .filter((e) => category === undefined || e.category === category)
        .map((e) => catalogGroup(catalog, e))
    : [];
  const floorPatterns = Math.min(assets.floorPatterns, MAX_FLOOR_PATTERN);
  return {
    furniture,
    categories: catalog
      ? FURNITURE_CATEGORIES.filter((c) => catalog.categories.includes(c.id)).map((c) => c.id)
      : [],
    floor_patterns: Array.from({ length: floorPatterns }, (_, i) => ({ pattern: i + 1 })),
    wall_sets: Array.from({ length: assets.wallSets }, (_, i) => ({
      wall_set: i,
      label: WALL_SET_LABELS[i] ?? `Wall ${i + 1}`,
    })),
    carpets: Array.from({ length: assets.carpets }, (_, i) => ({ variant: i })),
    pets: assets.pets.map((pet, i) => ({ pet_type: i, id: pet.id, name: pet.name })),
    rules: CATALOG_RULES,
  };
}

/** How to read the catalogue and place things validly (the agent's manual for edit_layout). */
const CATALOG_RULES = {
  coordinates:
    'Tiles are (col, row), 0-based from the top-left. A furniture item is placed by the top-left ' +
    'tile of its footprint (col, row); it covers footprint.width columns and footprint.height rows.',
  furniture:
    'An item must lie inside the grid. Its footprint rows below the first background_rows must ' +
    "be on floor (not wall, not void) and must not overlap another item's rows below its own " +
    'background_rows. Background rows may overlap walls and other items, and characters walk ' +
    'through them.',
  surfaces:
    'A can_place_on_surfaces item (PC, mug…) may also overlap the footprint tiles of is_desk items ' +
    '(and only those): it still needs floor under it and may not overlap anything else. Moving a ' +
    'desk carries what stands on it.',
  walls:
    'A can_place_on_walls item is placed by the same top-left (col, row) as any item: its BOTTOM ' +
    'footprint row (row + footprint.height - 1) must lie on wall tiles inside the grid, and the rows ' +
    'above may extend past the top edge (row may be negative). get_layout reports it the same way.',
  rotation:
    'Each orientation is its own type with its own footprint (`orientations[].type`); place the one ' +
    'you want directly. Rotating an item steps it to another member of the same list.',
  states:
    'on_type / states.on is the switched-on look of the same item (toggle swaps them). PCs are ' +
    'switched on automatically while an agent works at them; place the off type.',
  seats: 'Every footprint tile of a chairs item below its background rows is a seat.',
  floor:
    'A floor tile has a pattern (floor_patterns[].pattern) and a colour in colorize mode ' +
    '({h 0..360, s 0..100, b -100..100, c -100..100, colorize: true}).',
  wall_colors:
    'Walls take a wall_set (wall_sets[].wall_set) and a colour {h, s, b, c, colorize: true}.',
  furniture_colors:
    'Furniture colour is {h, s, b, c} — adjust mode by default (h -180..180, s/b/c -100..100, ' +
    'shifting the art), or {…, colorize: true} to tint it (h 0..360, s 0..100). Omit for the art as drawn.',
  carpets:
    'Carpets lie on floor tiles (not walls or void): a variant (carpets[].variant) with optional ' +
    'main and accent colours {h, s, b, c, colorize: true}.',
  areas: 'Area colours are "#rrggbb". Areas cover floor tiles only.',
  pets: 'A pet is placed by its pet_type (pets[].pet_type); the office holds one of each.',
  grid:
    `The grid grows to ${MAX_COLS}x${MAX_ROWS} at most (resize_grid). ` +
    'Growing it left or up shifts every tile and item ' +
    'by that much, later ops in the same batch included. Only an edge of void tiles with no furniture ' +
    'on it can be cut.',
  edit_layout:
    'edit_layout applies its ops in order to a copy and keeps all or none: check each placement ' +
    'against these rules, and read a refusal (op index + reason) to fix the batch. It is refused ' +
    'while someone has unsaved changes in the layout editor; undo_layout_edit reverts the newest edit.',
};
