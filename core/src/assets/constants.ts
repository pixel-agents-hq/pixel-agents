/**
 * Shared constants — used by the extension host, Vite build scripts,
 * and future standalone backend.
 *
 * No VS Code dependency. Only asset parsing and layout-related values.
 */

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 2;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── Pet Sprite Dimensions (96×96 spritesheet) ──────────────
export const PET_FRAME_W_SMALL = 16;
export const PET_FRAME_H = 32;
export const PET_FRAME_W_LARGE = 32;
export const PET_IMAGE_WIDTH = 96;
export const PET_IMAGE_HEIGHT = 96;
export const PET_WALK_FRAMES_VERT = 3;
export const PET_IDLE_FRAMES_VERT = 3;
export const PET_WALK_FRAMES_HORIZ = 3;
export const MAX_PET_PNG_SIZE = 512 * 1024; // 512 KB cap per pet PNG

// ── Carpet auto-tile parsing ────────────────────────────────
export const CARPET_TILE_SIZE = 16;
export const CARPET_GRID_COLS = 4;
export const CARPET_MARCHING_SQUARES_COUNT = 16;

// ── Nakama sprites (static 4-view character art) ────────────
/** Height every Nakama is scaled to, in world pixels (same as CHAR_FRAME_H). */
export const NAKAMA_HEIGHT_PX = 32;
/** Widest a Nakama may be, in world pixels (wings, hats, staffs are scaled down to fit). */
export const NAKAMA_MAX_WIDTH_PX = 32;
/** Per-channel distance from pure white still treated as background. */
export const NAKAMA_WHITE_TOLERANCE = 40;
/** Breaks in the outline up to twice this many source pixels are sealed
 *  before the background is flooded, so light hair behind them survives. */
export const NAKAMA_OUTLINE_GAP_PX = 5;
/** A detached part smaller than this fraction of the largest is a stray mark. */
export const NAKAMA_MIN_PART_RATIO = 0.04;
/** A detached part below this fraction of the largest that floats more than
 *  NAKAMA_FAR_PART_GAP_PX source pixels away from it is a stray mark too. */
export const NAKAMA_FAR_PART_RATIO = 0.25;
export const NAKAMA_FAR_PART_GAP_PX = 8;
/** Coverage (0-255) a downscaled pixel needs to be drawn; below it, transparent. */
export const NAKAMA_COVERAGE_THRESHOLD = 128;
