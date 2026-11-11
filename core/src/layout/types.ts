/**
 * The office layout's data model, shared by the webview's editor and the server.
 * Pure data: no sprites, no runtime state.
 */

import type { ColorValue } from '../schemas.js';

export type { ColorValue } from '../schemas.js';

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  FLOOR_8: 8,
  FLOOR_9: 9,
  VOID: 255,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export interface PlacedFurniture {
  uid: string;
  type: string; // asset ID from furniture manifest
  col: number;
  row: number;
  /** Optional color override for furniture */
  color?: ColorValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARPETS — visual layer between floor and furniture. Walkable, decorative.
// ─────────────────────────────────────────────────────────────────────────────

export interface CarpetTile {
  /** Variant index into the loaded carpet sprite sets (0 .. getCarpetSetCount()-1). */
  variant: number;
  /** Main colorization (lowest-luminance pixels). Defaults to CARPET_DEFAULT_COLOR when omitted. */
  color?: ColorValue;
  /** Accent colorization (highest-luminance pixels). Defaults to CARPET_DEFAULT_ACCENT_COLOR when omitted. */
  accentColor?: ColorValue;
  /** Stacking order at overlapping junctions. Higher draws on top. Defaults to 0. */
  order?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AREAS — translucent named overlays for Directory ↔ seat preference.
// ─────────────────────────────────────────────────────────────────────────────

export interface AreaDefinition {
  /** Stable label used as the FK in `areaTiles` and `OfficeState.areaMappings`. */
  label: string;
  /** Hex color (e.g. "#ff6b6b"). RGB only — alpha applied at render time. */
  color: string;
}

/** Persisted pet record (lives on OfficeLayout). */
export interface PlacedPet {
  /** crypto.randomUUID() generated when first toggled on. */
  id: string;
  /** Index into the loaded pet sprite array. */
  petType: number;
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Per-tile color settings, parallel to tiles array (floors and walls alike). null = no color */
  tileColors?: Array<ColorValue | null>;
  /**
   * Per-tile wall set (index into the loaded wall sets), parallel to tiles.
   * Only wall tiles carry one; null or absent = set 0, so layouts from before
   * wall sets keep their walls.
   */
  wallSets?: Array<number | null>;
  /** Bumped when the bundled default layout changes; forces a reset on existing installs */
  layoutRevision?: number;
  /** Pets placed in the office. Optional for backward-compat; migrateLayout coerces to []. */
  pets?: PlacedPet[];
  /** Per-tile carpet data, parallel to tiles array. null/undefined = no carpet on tile. */
  carpetTiles?: Array<CarpetTile | null>;
  /** Area definitions referenced by `areaTiles` labels. Distinct labels required. */
  areas?: AreaDefinition[];
  /** Per-tile Area label, parallel to tiles array. null = no area assignment. */
  areaTiles?: Array<string | null>;
}

/** A seat derived from a chair's footprint tile (layoutToSeats). */
export interface Seat {
  /** Chair furniture uid (`uid`, `uid:1`, `uid:2`… for multi-tile chairs) */
  uid: string;
  /** Tile col where agent sits */
  seatCol: number;
  /** Tile row where agent sits */
  seatRow: number;
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction;
  /** Runtime flag: an agent holds this seat. layoutToSeats always starts it false. */
  assigned: boolean;
}

/** A tile position on the grid. */
export interface TilePos {
  col: number;
  row: number;
}
