/**
 * Layout constants the pure layout operations need. The webview re-exports them
 * from webview-ui/src/constants.ts, so its imports stay where they were.
 */

import type { ColorValue } from '../schemas.js';

// ── Grid ─────────────────────────────────────────────────────

/** Pixels per tile side. */
export const TILE_SIZE = 16;
/** Size of the fallback layout (createDefaultLayout). */
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
/** Grid expansion stops here. */
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Colours ──────────────────────────────────────────────────

/** The colour a floor tile painted without one takes. */
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };
/** The wall brush's colour before anything sets it (the editor's, and edit_layout's when a
 *  layout has no wall to take one from). */
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };

// ── Wall sets ────────────────────────────────────────────────

/** Names of the bundled wall sets, by index (wall_N.png); sets past these are "Wall N". */
export const WALL_SET_LABELS = [
  'Plain',
  'Brick',
  'Wood planks',
  'Stone',
  'Wainscot',
  'Office panel',
  'Glass partition',
  'Half panel',
  'Cubicle',
];

// ── Workstations (seat ↔ PC pairing) ─────────────────────────

/** How far straight ahead of a seat a PC may stand and still be its own. */
export const AUTO_ON_FACING_DEPTH = 3;
/** How deep a PC one tile to the side of a seat's line may stand. */
export const AUTO_ON_SIDE_DEPTH = 2;

// ── Visits ───────────────────────────────────────────────────

/** How long a visiting character lingers at the spot before wandering as usual
 *  (the office's timer, and the server's measure of when a visit is over). */
export const VISIT_LINGER_MS = 20_000;
/** How far from a piece of furniture a visit may stand when nothing beside it is free. */
export const VISIT_SPOT_MAX_DISTANCE = 3;
