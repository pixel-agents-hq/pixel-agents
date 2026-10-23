import type { ColorValue } from './components/ui/types.js';

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48;
export const WALK_FRAME_DURATION_SEC = 0.15;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
/** The whole 16×32 frame: a Clawd lives in its lower half (rows 16-31). */
export const MATRIX_SPRITE_ROWS = 32;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
/** Sleeping agents (session open but idle, agentSleep) render dimmed — through
 *  the same alpha path as headless ones; the fainter of the two wins. */
export const SLEEPING_CHARACTER_ALPHA = 0.4;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
export const BUTTON_MIN_RADIUS = 6;
export const BUTTON_RADIUS_ZOOM_FACTOR = 3;
export const BUTTON_ICON_SIZE_FACTOR = 0.45;
export const BUTTON_LINE_WIDTH_MIN = 1.5;
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;
export const FALLBACK_FLOOR_COLOR = '#808080';

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)';
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)';
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)';
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)';
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2];
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)';
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)';
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)';
export const GHOST_VALID_TINT = '#00ff00';
export const GHOST_INVALID_TINT = '#ff0000';
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4';
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)';
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)';
export const BUTTON_ICON_COLOR = '#fff';
export const CANVAS_FALLBACK_TILE_COLOR = '#444';
export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';
export const WALL_COLOR = '#3A3A5C';

// ── Camera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1;
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5;

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 10;
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500;
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000;
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5;
export const ZOOM_SCROLL_THRESHOLD = 50;
/** The zoom buttons and Ctrl+wheel move by about this ratio a step (a whole
 *  +1 step was a 50% jump at 2x). */
export const ZOOM_STEP_RATIO = 1.15;
/** Zoom levels are multiples of this, so a 16 px tile stays a whole number of
 *  device pixels (16 × 0.25 = 4) and the floor never shows seams. */
export const ZOOM_QUANTUM = 0.25;
export const PAN_MARGIN_FRACTION = 0.25;

// ── Camera controls (office/camera.ts) ───────────────────────
/** Arrow keys / WASD: one press glides the camera this many tiles... */
export const KEY_PAN_STEP_TILES = 3;
/** ...easing out at this rate (1/s, exponential: ~95% of a step has landed
 *  after 0.3 s)... */
export const KEY_PAN_GLIDE_RATE_PER_SEC = 10;
/** ...and a key held down keeps the camera moving at this speed. */
export const KEY_PAN_HOLD_TILES_PER_SEC = 8;
/** A left-button press on the office becomes a pan once the pointer has moved
 *  this far (CSS px); anything shorter is still a click. */
export const MOUSE_DRAG_PAN_THRESHOLD_PX = 5;
/** What Fit keeps clear around the office (CSS px), per shell. Desktop: the
 *  zoom buttons top-left, the card bar along the right edge, the toolbar and
 *  done-today strip along the bottom (just the strip in a read-only office,
 *  which has no toolbar). Phones: the Fit / Settings buttons top-left and the
 *  compact strip at the bottom. */
export const FIT_MARGINS_DESKTOP = { top: 16, right: 88, bottom: 120, left: 64 } as const;
export const FIT_MARGINS_DESKTOP_READ_ONLY = { top: 16, right: 88, bottom: 56, left: 64 } as const;
export const FIT_MARGINS_MOBILE = { top: 48, right: 8, bottom: 36, left: 8 } as const;

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50;
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;
/** data-testid of the office canvas — e2e drives real editor gestures on it. */
export const OFFICE_CANVAS_TEST_ID = 'office-canvas';
/** Ghost-border hover tile when the border isn't shown — off any reachable tile. */
export const GHOST_BORDER_NO_HOVER_TILE = -999;

// ── Layout Import/Export (browser-native, standalone) ────────
/** Suggested filename when exporting the office layout from the standalone browser. */
export const LAYOUT_EXPORT_FILENAME = 'pixel-agents-layout.json';
/** MIME type for the exported layout Blob. */
export const LAYOUT_EXPORT_MIME = 'application/json';
export const DEFAULT_FLOOR_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 };
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// ── Carpets ──────────────────────────────────────────────────
/** Main (lowest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_COLOR: ColorValue = { h: 0, s: 71, b: -32, c: 0, colorize: true };
/** Accent (highest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_ACCENT_COLOR: ColorValue = {
  h: 34,
  s: 64,
  b: 21,
  c: 0,
  colorize: true,
};
/** Keyboard key that switches from CARPET_PAINT to CARPET_PICK while editing. */
export const KEY_CARPET_PICK = 'p';

// ── Areas (named, colored Directory zones) ───────────────────
/** Color palette assigned to new Areas in rotation (cycles when more areas exist). */
export const AREA_DEFAULT_COLORS: readonly string[] = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
] as const;
/** Translucent overlay alpha for area tile fills. */
export const AREA_OVERLAY_ALPHA = 0.25;
/** Alpha multiplier applied to the actively-selected area's overlay. */
export const AREA_ACTIVE_ALPHA_MULTIPLIER = 1.6;
/** Base font size (pixel-pre-zoom) for area centroid labels. */
export const AREA_LABEL_FONT_SIZE_PX = 14;
/** Minimum on-screen label size to keep labels legible at low zoom. */
export const AREA_LABEL_MIN_FONT_SIZE_PX = 12;
/** Alpha of the area label text. */
export const AREA_LABEL_ALPHA = 1.0;
/** Fallback label color when an area has no color set (shouldn't happen in practice). */
export const AREA_LABEL_FALLBACK_COLOR = '#ffffff';
/** Drop-shadow color behind area labels for legibility on light backgrounds. */
export const AREA_LABEL_SHADOW_COLOR = '#000000';
/** Drop-shadow alpha behind area labels. */
export const AREA_LABEL_SHADOW_ALPHA = 0.6;

// ── VisualColorPicker (HSV wheel + brightness for carpets) ───
export const VISUAL_COLOR_PICKER_SV_SIZE_PX = 180;
export const VISUAL_COLOR_PICKER_HUE_WIDTH_PX = 20;
export const VISUAL_COLOR_PICKER_MARKER_RADIUS_PX = 6;
/**
 * The hue bar gradient is intrinsic to the color-picking interaction, not a
 * theme color — it must span the full hue circle. Centralized here so the
 * component body stays free of inline color literals. (The saturation/brightness
 * square is painted to a canvas from the carpet HSL model, not a CSS gradient.)
 */
export const VISUAL_COLOR_PICKER_HUE_GRADIENT =
  'linear-gradient(to bottom, ' +
  '#ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, ' +
  '#00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)';
export const VISUAL_COLOR_PICKER_MARKER_BORDER = '2px solid #fff';
export const VISUAL_COLOR_PICKER_MARKER_SHADOW = '0 0 0 1px rgba(0,0,0,0.6)';
/** Width of the collapsed swatch + hex trigger row (compact mode). */
export const VISUAL_COLOR_PICKER_COMPACT_WIDTH_PX = 160;
/** Swatch square size shown in the collapsed trigger. */
export const VISUAL_COLOR_PICKER_SWATCH_PX = 22;
/** Gap (px) between the collapsed trigger and the expanded popup panel. */
export const VISUAL_COLOR_PICKER_POPUP_GAP_PX = 6;

// ── Notification Sound (done: ascending chime) ─────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25; // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51; // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0;
export const NOTIFICATION_NOTE_2_START_SEC = 0.1;
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18;
export const NOTIFICATION_VOLUME = 0.14;

// ── Permission Sound (attention: descending double tap) ────
export const PERMISSION_NOTE_1_HZ = 880; // A5
export const PERMISSION_NOTE_2_HZ = 659.25; // E5 (down a fourth)
export const PERMISSION_NOTE_1_START_SEC = 0;
export const PERMISSION_NOTE_2_START_SEC = 0.12;
export const PERMISSION_NOTE_DURATION_SEC = 0.15;
export const PERMISSION_VOLUME = 0.12;

// ── Celebrations (living office phase B: a push or PR lands) ─
// docs/office/DESIGN.md "B. Celebrations": a bell on the shipper's desk, a
// confetti burst over them, and a trophy on the trophy wall.
/** A `git push` / `gh pr create` this recent (ms) claims a new push / PR. */
export const SHIP_ATTRIBUTION_WINDOW_MS = 10 * 60_000;
/** The bell that appears on the shipping agent's desk (office pack). */
export const BELL_FURNITURE_TYPE = 'BELL';
/** It stands on the desk top up to this many tiles ahead of the seat (past
 *  a desk's walk-behind background row). */
export const BELL_DESK_DEPTH = 2;
/** How long the bell stays on the desk. */
export const BELL_SHOW_SEC = 3;
/** Its ring: a sideways wobble at this rate... */
export const BELL_WOBBLE_HZ = 6;
/** ...swinging this far (sprite px) at first... */
export const BELL_WOBBLE_PX = 1.5;
/** ...and still after this long. */
export const BELL_WOBBLE_SEC = 1.6;
/** The bell sound: a struck bell, a fundamental plus inharmonic partials. */
export const BELL_SOUND_FUNDAMENTAL_HZ = 1046.5; // C6
export const BELL_SOUND_PARTIALS: ReadonlyArray<{
  ratio: number;
  gain: number;
  decaySec: number;
}> = [
  { ratio: 1, gain: 1, decaySec: 1.4 },
  { ratio: 2.76, gain: 0.4, decaySec: 0.7 },
  { ratio: 5.4, gain: 0.15, decaySec: 0.35 },
];
export const BELL_SOUND_VOLUME = 0.07;
export const BELL_SOUND_ATTACK_SEC = 0.005;
/** Confetti: particles per burst, launched from this far above the feet (px). */
export const CONFETTI_PARTICLE_COUNT = 40;
export const CONFETTI_ORIGIN_DY = -26;
/** Each particle lives 80-100% of this long, fading out over the last CONFETTI_FADE_SEC. */
export const CONFETTI_LIFE_SEC = 2.5;
export const CONFETTI_LIFE_MIN_FRACTION = 0.8;
export const CONFETTI_FADE_SEC = 0.8;
/** Launch speed range (sprite px/s) inside a cone this wide (radians) around straight up. */
export const CONFETTI_SPEED_MIN = 45;
export const CONFETTI_SPEED_MAX = 100;
export const CONFETTI_SPREAD_RAD = Math.PI * 0.7;
/** Gravity (px/s²), paper-like terminal fall speed (px/s), sideways air drag (1/s). */
export const CONFETTI_GRAVITY = 150;
export const CONFETTI_TERMINAL_VY = 40;
export const CONFETTI_DRAG = 1.5;
/** A flake flips between 2×1 and 1×1 px this often (flips per second). */
export const CONFETTI_FLIP_HZ = 5;
export const CONFETTI_COLORS: readonly string[] = [
  '#f2c94c', // gold
  '#eb5757', // red
  '#56ccf2', // sky
  '#6fcf97', // green
  '#bb6bd9', // purple
  '#f2994a', // orange
];
/** Trophy wall: shelves are these bookshelves (in the Lounge, when the layout has one). */
export const TROPHY_SHELF_TYPE = 'DOUBLE_BOOKSHELF';
/** PRs are cups, in this order (cycling)... */
export const TROPHY_CUP_TYPES: readonly string[] = [
  'TROPHY_CUP_GOLD',
  'TROPHY_CUP_SILVER',
  'TROPHY_CUP_BRONZE',
];
/** ...pushes are boxes, one per push after the cups. */
export const TROPHY_BOX_TYPE = 'TROPHY_BOX';
/** A trophy stands in its shelf's gap: one tile right of the shelf's top-left. */
export const TROPHY_SLOT_DCOL = 1;
export const TROPHY_SLOT_DROW = 0;

// ── Furniture Animation ─────────────────────────────────────
export const FURNITURE_ANIM_INTERVAL_SEC = 0.2;

// ── Living office (zones, destinations, effects) ────────────
// docs/office/DESIGN.md. Zones are layout Areas with reserved labels; a layout
// without them skips the whole behaviour.
/** A destination is kept at least this long before a character switches to
 *  another, so fast tool bursts don't make it pace back and forth. Switching
 *  TO its own desk (active) or to the Meeting room is immediate. */
export const ZONE_HOLD_MIN_SEC = 8;
/** A character whose zone was full looks for a free place again this often. */
export const ZONE_RETRY_INTERVAL_SEC = 1;
/** An agent that closes within this long of walking in skips the walk out
 *  (and has its walk in cut short): it despawns where it stands. */
export const TRANSIENT_SESSION_SEC = 20;
/** Tool names that are a shell command (a live one in phase `test` → Server). */
export const ZONE_SHELL_TOOL_NAMES: readonly string[] = ['Bash', 'PowerShell'];
/** The tool that asks the user something (live → Meeting, like a permission). */
export const ZONE_ASK_USER_TOOL_NAME = 'AskUserQuestion';
/** Furniture the zones key on, by type prefix (SERVER_RACK_OFF / _ON_1 / ...). */
export const ZONE_ASHTRAY_TYPE_PREFIX = 'ASHTRAY';
export const ZONE_SERVER_RACK_TYPE_PREFIX = 'SERVER_RACK';
/** Cigarette held by a character at a Smoke spot, in sprite px from its feet
 *  anchor (bottom-center): the hand's height, where the cigarette starts when
 *  it faces the viewer or away (just past the hand at its side) or sideways
 *  (just in front of its body), and its length (paper, then one lit px). */
export const CIGARETTE_HAND_RISE_PX = 9;
export const CIGARETTE_REACH_FRONT_PX = 6;
export const CIGARETTE_REACH_SIDE_PX = 4;
export const CIGARETTE_LENGTH_PX = 3;
/** Sorts the cigarette and its smoke just in front of the smoker. */
export const CIGARETTE_Z_SORT_OFFSET = 0.01;
export const CIGARETTE_PAPER_COLOR = '#f2f0ea';
export const CIGARETTE_TIP_COLOR = '#ff8a2a';
/** The tip while inhaling, and the dead tip it fades to when stubbed out. */
export const CIGARETTE_TIP_GLOW_COLOR = '#ffd23f';
export const CIGARETTE_ASH_COLOR = '#8c8c8c';
/** A butt left in the ashtray: paper px, then the filter px. */
export const CIGARETTE_FILTER_COLOR = '#d98a3d';
/** The lighter's 2-frame flick: a spark, then a small flame. */
export const LIGHTER_SPARK_COLOR = '#fff4b0';
export const LIGHTER_FLAME_COLOR = '#ff9d2e';
/** Mouth (the exhale), in sprite px from the feet anchor: its height, and how
 *  far in front of the face it is when the character faces sideways. */
export const SMOKE_MOUTH_RISE_PX = 19;
export const SMOKE_MOUTH_SIDE_PX = 5;
/** Facing away the mouth is hidden: the exhale shows this much higher, over the head. */
export const SMOKE_MOUTH_BACK_EXTRA_RISE_PX = 7;
/** A smoke break's timeline, in seconds after arriving at the Smoke spot:
 *  the lighter flicks for the light-up, the first drag follows after a beat,
 *  then one about every period (± half the jitter: ~4-6 s). A drag is an
 *  inhale (the tip glows), a pause, and an exhale cloud from the mouth. */
export const SMOKE_LIGHT_UP_SEC = 0.8;
export const SMOKE_LIGHTER_FRAME_SEC = 0.12;
export const SMOKE_FIRST_DRAG_DELAY_SEC = 1.5;
export const SMOKE_DRAG_PERIOD_SEC = 5;
export const SMOKE_DRAG_JITTER_SEC = 1;
export const SMOKE_INHALE_SEC = 0.4;
export const SMOKE_EXHALE_DELAY_SEC = 0.3;
export const SMOKE_EXHALE_LIFETIME_SEC = 2;
export const SMOKE_EXHALE_RISE_PX_PER_SEC = 5;
/** Squares in an exhale cloud, the delay between them, and their spread. */
export const SMOKE_EXHALE_PUFFS = 3;
export const SMOKE_EXHALE_STAGGER_SEC = 0.12;
export const SMOKE_EXHALE_SPREAD_PX = 1.5;
/** The shared "wind": every cloud and wisp drifts this way (px/s, + = right). */
export const SMOKE_WIND_PX_PER_SEC = 2.5;
/** Between drags thin wisps rise off the tip: one this often, 1 px, faint. */
export const SMOKE_WISP_INTERVAL_SEC = 0.8;
export const SMOKE_WISP_LIFETIME_SEC = 1.6;
export const SMOKE_WISP_RISE_PX_PER_SEC = 6;
export const SMOKE_WISP_ALPHA = 0.35;
/** Smoke squares grow to this size, starting from this alpha, wobbling. */
export const SMOKE_PUFF_MAX_SIZE_PX = 3;
export const SMOKE_PUFF_START_ALPHA = 0.55;
export const SMOKE_PUFF_DRIFT_PX = 1;
export const SMOKE_PUFF_WOBBLE_RAD_PER_SEC = 2.2;
export const SMOKE_PUFF_COLOR = '#d8d8d8';
/** Some drags are followed by an ash flick: a grey px falls off the tip
 *  toward the ashtray. */
export const SMOKE_ASH_FLICK_CHANCE = 0.35;
export const SMOKE_ASH_FLICK_AFTER_SEC = 2.2;
export const SMOKE_ASH_FALL_SEC = 0.5;
export const SMOKE_ASH_FALL_PX = 6;
export const SMOKE_ASH_DRIFT_PX = 2;
/** Called away, a smoker stubs its cigarette out on the ashtray first: the
 *  ember fades out over this long, then it goes. */
export const SMOKE_STUB_OUT_SEC = 1;
/** The ashtray fills with butts as the longest current wait on the user grows:
 *  one per this many seconds, at these spots of the ashtray's bowl (sprite px
 *  from its top-left; their count is the cap). Empty when nobody waits. */
export const ASHTRAY_BUTT_WAIT_SEC = 5 * 60;
export const ASHTRAY_BUTT_SLOTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 5, y: 16 },
  { x: 7, y: 14 },
  { x: 8, y: 16 },
  { x: 10, y: 15 },
];
/** Mid-work smoke breaks (the "waiting on the user" smoke is separate):
 *  (A) a shell command that isn't a test/build, running longer than this... */
export const SMOKE_LONG_COMMAND_SEC = 45;
/** ...(B) or a break after this much continuous work, at most once per the
 *  cooldown, taken with this chance at a gap of this long with no live tool,
 *  lasting min + up to range seconds. */
export const SMOKE_BREAK_AFTER_WORK_SEC = 40 * 60;
export const SMOKE_BREAK_COOLDOWN_SEC = 60 * 60;
export const SMOKE_BREAK_CHANCE = 0.25;
export const SMOKE_BREAK_GAP_SEC = 3;
export const SMOKE_BREAK_MIN_SEC = 60;
export const SMOKE_BREAK_RANGE_SEC = 30;
/** The label tag of a mid-work smoker (its activity text stays). */
export const SMOKE_BREAK_TAG = '🚬 break';

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 6;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;
/** Label de-overlap (office/labelLayout.ts): colliding labels stack upward
 *  with this gap between them... */
export const LABEL_STACK_GAP_PX = 3;
/** ...but none is lifted further than this above its own character — past it
 *  a label stays put (overlapping) rather than drift away from who it labels. */
export const LABEL_MAX_SHIFT_PX = 96;
/** Labels whose bottom edges fall in the same band of this many px count as
 *  one row and stack in agent-id order, so a pixel of difference between
 *  seated neighbours can't flip which one moves from frame to frame. */
export const LABEL_ROW_BAND_PX = 6;
/** A label's task title is cut to this many characters (` · repo` follows);
 *  the hovered or selected label shows it whole, up to the wide max width. */
export const LABEL_TITLE_MAX_CHARS = 26;
export const LABEL_FOCUSED_MAX_WIDTH_PX = 440;
/** Phone + Always Show Labels: the labels nobody is looking at shrink to their
 *  activity line at this size and width (office/agentLabel.ts labelDensity)... */
export const COMPACT_LABEL_FONT_PX = 14;
export const COMPACT_LABEL_MAX_WIDTH_PX = 120;
/** ...and sit this far above the character's head anchor (one short row). */
export const COMPACT_LABEL_LIFT_PX = 20;

// ── Remote Workers panel (background agents) ───────────────
/** Desktop: the panel hangs under the zoom controls (top-8 + three 40px
 *  buttons with 4px gaps = 136px), clear of the TODAY strip and toolbar. */
export const REMOTE_WORKERS_TOP_PX = 148;
export const REMOTE_WORKERS_WIDTH_PX = 230;
/** Room kept free below the panel for the TODAY strip + toolbar, so a long
 *  list scrolls instead of running into them. */
export const REMOTE_WORKERS_BOTTOM_RESERVE_PX = 140;
/** Phone: the chip sits bottom-right, this far up — just above the version
 *  label (bottom-8, text-lg) and level with nothing else. */
export const REMOTE_WORKERS_MOBILE_BOTTOM_PX = 44;
/** Phone: the expanded list's width and the share of the office height it may take. */
export const REMOTE_WORKERS_MOBILE_WIDTH_PX = 260;
export const REMOTE_WORKERS_MOBILE_MAX_HEIGHT_RATIO = 0.5;
/** How often the tiles re-read the clock (a sleeping worker's "idle 3h"). */
export const REMOTE_WORKERS_CLOCK_MS = 60_000;

// ── Living office: ambience (docs/office/DESIGN.md, phase C) ──
/** Time of day by the PC's local hour: day [DAY, DUSK), dusk [DUSK, NIGHT)
 *  and [DAWN, DAY), night otherwise. */
export const AMBIENCE_DAWN_HOUR = 6;
export const AMBIENCE_DAY_HOUR = 7;
export const AMBIENCE_DUSK_HOUR = 17;
export const AMBIENCE_NIGHT_HOUR = 19;
/** The wall window's three furniture types; any placed one shows the current one. */
export const WINDOW_DAY_TYPE = 'WINDOW_DAY';
export const WINDOW_DUSK_TYPE = 'WINDOW_DUSK';
export const WINDOW_NIGHT_TYPE = 'WINDOW_NIGHT';
/** Night lights: a gentle wash over the whole office, and a further one over
 *  each room (Area) nobody is in. Canvas only — labels and UI are DOM. */
export const NIGHT_DIM_COLOR = '#0a0f2e';
export const NIGHT_DIM_ALPHA = 0.22;
export const NIGHT_EMPTY_ROOM_DIM_ALPHA = 0.14;
/** Real clocks: the CLOCK_FACE sprite's hands, drawn from the local time. The
 *  face is the light ellipse around the pivot; a hand reaches `radius` px from
 *  it on each axis (the face is wider than it is tall). */
export const CLOCK_FACE_TYPE = 'CLOCK_FACE';
export const CLOCK_PIVOT = { x: 7, y: 16 } as const;
export const CLOCK_MINUTE_HAND_RADIUS = { x: 4, y: 3 } as const;
export const CLOCK_HOUR_HAND_RADIUS = { x: 2, y: 2 } as const;
export const CLOCK_HAND_COLOR = '#73787e';
/** Name plates on occupied Dev desks (runtime-only furniture, never saved).
 *  The plate's blank brass face in its sprite, and the 3×5 text drawn on it. */
export const NAME_PLATE_TYPE = 'NAME_PLATE';
export const NAME_PLATE_FACE = { x: 3, y: 3, w: 10, h: 2 } as const;
/** The plate's bottom edge in its sprite (px from the top). */
export const NAME_PLATE_SPRITE_BOTTOM_PX = 8;
/** It stands this far above the desk sprite's bottom: on the front edge of the
 *  desktop, above the desk's front panel. */
export const NAME_PLATE_DESK_FRONT_INSET_PX = 7;
export const NAME_PLATE_TEXT_COLOR = '#301c1c';
/** Café coffee runs: while working, at a gap of more than GAP_SEC with no live
 *  tool (after one), CHANCE of a walk to the Café counter, at most once per
 *  cooldown; it stands there MIN + up to RANGE seconds and carries the cup
 *  back for CARRY_SEC. Gives up after MAX_SEC if it can't get there. */
export const COFFEE_MACHINE_TYPE_PREFIX = 'COFFEE_MACHINE';
export const COFFEE_RUN_GAP_SEC = 4;
export const COFFEE_RUN_CHANCE = 0.15;
export const COFFEE_RUN_COOLDOWN_SEC = 30 * 60;
export const COFFEE_RUN_STAND_MIN_SEC = 6;
export const COFFEE_RUN_STAND_RANGE_SEC = 4;
export const COFFEE_RUN_MAX_SEC = 90;
export const COFFEE_CUP_CARRY_SEC = 20;
/** The coffee runs' RNG seed (deterministic; tests replace the RNG). */
export const COFFEE_RNG_SEED = 0xc0ffee;
/** The cup: 2 px wide, 3 tall (a coffee px on top), held at the hand. */
export const COFFEE_CUP_COLOR = '#f4f1ea';
export const COFFEE_CUP_COFFEE_COLOR = '#6b3e26';
/** Receptionist: a non-agent NPC behind the Entrance's RECEPTION_DESK who
 *  waves (2 frames: arm up, then arm out with a 1 px bob) as an agent walks in. */
/** Its own reserved id: it once shared ANSH_NPC_ID, so the receptionist was drawn
 *  and recognized as Ansh. Every reserved NPC id must be distinct. */
export const RECEPTIONIST_ID = -1_000_000_003;
export const RECEPTION_DESK_TYPE_PREFIX = 'RECEPTION_DESK';
export const RECEPTIONIST_PALETTE = 1;
export const RECEPTIONIST_WAVE_SEC = 1.5;
export const RECEPTIONIST_WAVE_FRAME_SEC = 0.25;
export const RECEPTIONIST_HAND_COLOR = '#f2c49b';
export const RECEPTIONIST_HAND_OUTLINE_COLOR = '#3b2626';

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** ToolOverlay stacking: status label panels (selected one on top), then the
 *  characters' speech bubbles above every label — all below the Intro bubble. */
export const OVERLAY_LABEL_Z_INDEX = 41;
export const OVERLAY_LABEL_SELECTED_Z_INDEX = 42;
export const OVERLAY_BUBBLE_Z_INDEX = 43;
/** Phone: the Remote Workers chip while its list is open — above the labels
 *  and bubbles the list covers, still below the Intro bubble. */
export const REMOTE_WORKERS_OPEN_Z_INDEX = 44;
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;

// ── Phase M: Ansh's office, the Manager, the Tasks board ────
/** Reserved ids for the two NPCs, next to GREETER_ID: never an agent's. */
export const ANSH_NPC_ID = -1_000_000_001;
export const MANAGER_NPC_ID = -1_000_000_002;
/** The user's own chibi and the Manager: fixed skins (palette index, hue°). */
export const ANSH_NPC_PALETTE = 1;
export const ANSH_NPC_HUE_SHIFT = 0;
export const MANAGER_NPC_PALETTE = 5;
export const MANAGER_NPC_HUE_SHIFT = 0;
/** Hover labels. */
export const ANSH_NPC_LABEL = 'Ansh';
export const MANAGER_NPC_LABEL = '📋 Manager';
/** Ansh's brain (ansh/anshStore.ts, engine/npcs.ts): how long he stays where a
 *  thought took him, how far a stretch goes, and how long his line shows. */
export const ANSH_VISIT_STAY_SEC = 6;
export const ANSH_CHAT_STAY_SEC = 8;
export const ANSH_STRETCH_STAY_SEC = 3;
export const ANSH_STRETCH_RADIUS_TILES = 6;
export const ANSH_BUBBLE_MS = 9_000;
/** Between thoughts Ansh wanders on his own (no claude): every MIN..MIN+RANGE
 *  seconds at his desk he walks to the Café, the Lounge, the Server room or a
 *  spot nearby, stays a while, and comes back. A thought cuts in at any point. */
export const ANSH_WANDER_MIN_SEC = 60;
export const ANSH_WANDER_RANGE_SEC = 90;
export const ANSH_WANDER_STAY_SEC = 10;
/**
 * Ansh's errands between thoughts (engine/anshErrands.ts): the human things he
 * does when the office has the furniture or the company for them. Each kind is
 * drawn by its weight among the kinds the layout offers right now (a kind with
 * no target is never drawn), never the same kind twice in a row when another
 * is on offer. A place in the Café / Lounge / Server room and a stretch nearby
 * stay on the list, quieter (nothing said).
 */
export const ANSH_ERRAND_WEIGHTS = {
  pet: 3,
  plant: 3,
  coffee: 3,
  reception: 2,
  manager: 2,
  window: 2,
  board: 2,
  fish: 2,
  place: 1,
  stretch: 1,
} as const;
/** How long he stays at each errand once there. */
export const ANSH_ERRAND_STAY_SEC = {
  pet: 6,
  plant: 6,
  coffee: 6,
  reception: 8,
  manager: 8,
  window: 7,
  board: 6,
  fish: 6,
} as const;
/** A line shows this long; the other side of a chat answers this long after his. */
export const ANSH_ERRAND_LINE_SEC = 4;
export const ANSH_ERRAND_REPLY_AT_SEC = 2.5;
/** Furniture an errand is for, by type prefix (wall items are stood under). */
export const ANSH_PLANT_TYPE_PREFIXES: readonly string[] = [
  'PLANT',
  'LARGE_PLANT',
  'CACTUS',
  'HANGING_PLANT',
];
export const ANSH_WINDOW_TYPE_PREFIX = 'WINDOW_';
export const ANSH_BOARD_TYPE_PREFIXES: readonly string[] = ['WHITEBOARD', 'NOTICE_BOARD'];
export const ANSH_FISH_TANK_TYPE_PREFIX = 'FISH_TANK';
/** Standing in front of an item: up to this many rows below its footprint
 *  (a machine on a counter is reached from below the counter). */
export const ANSH_ERRAND_REACH_ROWS = 2;
/** Across the reception desk from the receptionist: at most this many tiles out. */
export const ANSH_RECEPTION_REACH_TILES = 4;
/** A petted pet sits still for him and shows a heart this long. */
export const ANSH_PET_HEART_SEC = 3;
/** Back from the coffee machine: the cup stays in hand this long. */
export const ANSH_COFFEE_CUP_SEC = 45;
/** The watering can: a drop falls from the spout every PERIOD seconds. */
export const ANSH_WATERING_DROP_PERIOD_SEC = 0.6;
export const ANSH_WATERING_CAN_COLOR = '#5f8f6a';
export const ANSH_WATERING_CAN_DARK_COLOR = '#3e6347';
export const ANSH_WATER_DROP_COLOR = '#7cc4f2';
/** The receptionist's name over her lines. */
export const RECEPTIONIST_LABEL = 'Receptionist';
/** What he says (and hears). `{pet}` is the pet's name. */
export const ANSH_PET_LINES: readonly string[] = [
  "Who's a good {pet}?",
  'Hey {pet}. Keeping an eye on the builds?',
  '{pet}! Did you eat my snack again?',
  'Break time, {pet}.',
];
export const ANSH_PLANT_LINES: readonly string[] = [
  'There you go. Drink up.',
  "Still alive. That's one of us.",
  'Grow, little guy. Grow.',
  'A bit of water, a bit of sun.',
];
export const ANSH_COFFEE_LINES: readonly string[] = [
  'Coffee first. Then code review.',
  'One more cup. Just one.',
  'Ah. Fuel.',
  'Who left the machine on empty?',
];
export const ANSH_WINDOW_LINES: Readonly<Record<'day' | 'dusk' | 'night', readonly string[]>> = {
  day: ['Nice out today.', 'Should go for a walk later.', 'Sun is out. The agents are not.'],
  dusk: ['Getting late already?', 'Look at that sky.', 'One more hour. Then home.'],
  night: ['Dark out. Still shipping.', 'The city never sleeps. Neither do the agents.'],
};
export const ANSH_BOARD_LINES: readonly string[] = [
  'Who wrote this?',
  'Hm. That plan looks familiar.',
  'Need to update this.',
  'Okay. What did we promise this week?',
];
export const ANSH_FISH_LINES: readonly string[] = [
  'Lunch time, fish.',
  "Just a pinch. Don't tell the cat.",
  'You two get along in there?',
];
/** A chat: his line, then the answer. */
export const ANSH_RECEPTION_EXCHANGES: ReadonlyArray<readonly [string, string]> = [
  ['Anyone interesting come in?', 'Just agents. Lots of agents.'],
  ["How's the front desk?", 'Busy! They keep showing up.'],
  ['Any packages for me?', "Nothing yet. I'll let you know."],
  ['Quiet day?', 'For now. Knock on wood.'],
];
export const ANSH_MANAGER_EXCHANGES: ReadonlyArray<readonly [string, string]> = [
  ['How are we tracking?', 'On track. Mostly.'],
  ['Anything I should know?', "I'll have it in the report."],
  ['Busy day?', 'Every day is a busy day.'],
];
/** NPCs at their desks flip between two frames this often (slower than typing). */
export const NPC_IDLE_FRAME_SEC = 0.6;
/** On a report for today, the Manager stands by Ansh's desk this long. */
export const MANAGER_VISIT_STAY_SEC = 8;
/** An agent knocking on Ansh's door: twice (knock knock) every interval,
 *  each bob lifting the sprite KNOCK_BOB_PX world px for the duration. */
export const KNOCK_INTERVAL_SEC = 2;
export const KNOCK_BOB_OFFSETS_SEC: readonly number[] = [0, 0.3];
export const KNOCK_BOB_DURATION_SEC = 0.15;
export const KNOCK_BOB_PX = 1;
/** The Tasks board: above the overlays and the Intro bubble, below modals. */
export const TASKS_BOARD_Z_INDEX = 47;
/** Desktop side panel width (CSS px); phones get a full-screen sheet. */
export const TASKS_BOARD_WIDTH_PX = 600;
/** World px above the greeter's anchor (feet) where the bubble's bottom sits.
 *  Kept well above the head target (INTRO_TAIL_TARGET_RISE_WORLD) so the
 *  tail squares have a visible run between bubble and head. */
export const INTRO_BUBBLE_ANCHOR_RISE_WORLD = 44;
/** World px right of the greeter's center where the bubble's left edge starts —
 *  just clear of the sprite so the tail points down-left at the head. */
export const INTRO_BUBBLE_OFFSET_X_WORLD = 10;
/** Bubble width cap (CSS px) and the margin kept from the container edges.
 *  Wide on purpose: the disclosure reads as three short paragraphs instead of
 *  a tall column (still clamped to the container on narrow panels). */
export const INTRO_BUBBLE_MAX_WIDTH_PX = 560;
export const INTRO_BUBBLE_EDGE_MARGIN_PX = 4;
/** Where the Intro's Claude Code step sends people who don't have it yet. */
export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';
export const CLAUDE_CODE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
/** Speech-tail squares: placed at fraction `t` along the segment from the
 *  bubble's nearest edge point to the greeter's head, shrinking toward the
 *  speaker. Recomputed every frame so the tail stays connected no matter where
 *  edge-clamping or panning puts the bubble relative to the character. */
export const INTRO_TAIL_STEPS = [
  { t: 0.25, size: 12 },
  { t: 0.55, size: 9 },
  { t: 0.82, size: 6 },
] as const;
/** World px above the greeter's anchor (feet) the tail points at — the head. */
export const INTRO_TAIL_TARGET_RISE_WORLD = 26;
/** Camera-offset caps while centering character + bubble. The ideal composition
 *  assumes the bubble fits beside/above the character; when it can't (narrow or
 *  short viewports clamp the bubble to the screen), uncapped offsets shove the
 *  greeter to the viewport edge. Horizontal offset is capped to this fraction
 *  of the viewport; vertical offset always keeps this many world px of the
 *  character visible above the bottom edge. */
export const INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION = 0.25;
export const INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD = 48;
/** Extra downward camera shift (CSS px) so the character+bubble composition
 *  sits a bit above the vertical center instead of dead-centered. */
export const INTRO_CAMERA_DOWN_SHIFT_PX = 50;

// ── Context Fuel Gauge ──────────────────────────────────────
/** Window assumed before the runtime reports one (it always does for agents
 *  that have taken a turn; this only covers characters created ahead of it). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_WARN_THRESHOLD = 0.6;
export const CONTEXT_DANGER_THRESHOLD = 0.8;
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
export const CONTEXT_GAUGE_COLOR_WARN = '#ffcc00';
export const CONTEXT_GAUGE_COLOR_DANGER = '#ff8800';
export const CONTEXT_GAUGE_COLOR_CRITICAL = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

// ── Agent look: Clawd (office/agentLook.ts, office/sprites/clawdSprites.ts) ──
// Agents (sessions, sub-agents, teammates) are drawn as the classic chibis
// unless the view setting opts into Clawds — Claude Code's orange mascot. NPCs
// (Ansh, the Manager, the receptionist, the greeter) keep the chibi art either way.
/** The setting is a view preference, per browser: localStorage, never the server. */
export const AGENT_LOOK_STORAGE_KEY = 'pixel-agents.agentLook';
export const AGENT_LOOK_DEFAULT = 'classic';
/** The generated sheet's palette (scripts/generate-clawd-sprites.mjs). The eye
 *  colour is unique in the sheet: the blink and the glasses find the eyes by it. */
export const CLAWD_BODY_COLOR = '#D97757';
export const CLAWD_EYE_COLOR = '#1B1210';
/** Per-repo tints: HSL adjustments (adjustSprite) of the one orange sheet. A
 *  repo prefers the tint a stable hash of its name picks; the Clawds on the
 *  board are handed distinct ones, sticky per page (agentLook.ts). */
export const CLAWD_TINTS: ReadonlyArray<{ name: string; h: number; s: number; b: number }> = [
  { name: 'orange', h: 0, s: 0, b: 0 },
  { name: 'gold', h: 28, s: 10, b: 8 },
  { name: 'green', h: 105, s: -24, b: -6 },
  { name: 'teal', h: 160, s: -10, b: -4 },
  { name: 'sky', h: 195, s: -4, b: 2 },
  { name: 'violet', h: 250, s: -6, b: 6 },
  { name: 'pink', h: 318, s: -2, b: 6 },
];
/** The accessories' colours (their art is in clawdSprites.ts). */
export const CLAWD_ACCESSORY_COLORS = {
  outline: '#2A2024',
  cap: '#3B6FD9',
  capBrim: '#27489A',
  headset: '#34343F',
  headsetPad: '#6E6E80',
  mic: '#C9C9D2',
  beanie: '#C94C4C',
  beanieBand: '#9E3838',
  pompom: '#F4EEE4',
  bow: '#E8558F',
  bowKnot: '#B33068',
  glasses: '#23232E',
  antenna: '#3A3A44',
  antennaBall: '#FFCF4A',
} as const;
/** A blink: the eyes close for CLAWD_BLINK_CLOSED_SEC once per period (jittered per agent). */
export const CLAWD_BLINK_PERIOD_SEC = 4;
export const CLAWD_BLINK_CLOSED_SEC = 0.14;
/** Clawd geometry in sprite px from the feet anchor (the chibi values are the
 *  CIGARETTE_*, SMOKE_MOUTH_*, TOOL_OVERLAY_*, BUBBLE_*, CHARACTER_HIT_* and
 *  CONFETTI_ORIGIN_DY constants). A standing Clawd is 14 px tall (rows 17-30
 *  of the frame) and 12 wide; seated it sits 2 px lower. */
export const CLAWD_HEAD_RISE_PX = 15;
export const CLAWD_HAND_RISE_PX = 8;
export const CLAWD_REACH_FRONT_PX = 6;
export const CLAWD_REACH_SIDE_PX = 5;
export const CLAWD_MOUTH_RISE_PX = 9;
export const CLAWD_MOUTH_SIDE_PX = 5;
export const CLAWD_MOUTH_BACK_EXTRA_RISE_PX = 7;
export const CLAWD_LABEL_RISE_PX = 24;
/** A lead Clawd's crown stands this tall over its body: its label and bubble rise as much. */
export const CLAWD_LEAD_LABEL_LIFT_PX = 6;
export const CLAWD_BUBBLE_RISE_PX = 12;
export const CLAWD_BUBBLE_SITTING_OFFSET_PX = 8;
export const CLAWD_HIT_HEIGHT_PX = 18;
export const CLAWD_CONFETTI_RISE_PX = 16;
/** The mug shot crops the frame from this row for a Clawd (the body starts on row 16). */
export const CLAWD_MUGSHOT_CROP_TOP_ROW = 12;

// ── Pets ────────────────────────────────────────────────────────
/** Walking speed in world pixels per second (matches character walk speed visually but slower). */
export const PET_WALK_SPEED_PX_PER_SEC = 32;
/** Time per WALK animation cycle step (4 cycle steps × 0.15s = 0.6s per loop). */
export const PET_WALK_FRAME_DURATION_SEC = 0.15;
/** Time per IDLE animation cycle step (4 cycle steps × 0.3s = 1.2s per loop). */
export const PET_IDLE_FRAME_DURATION_SEC = 0.3;
/** Walk cycle: 4-step lookup into the 3-frame walkDown/walkUp/walkRight arrays. */
export const PET_WALK_SEQUENCE = [0, 1, 0, 2] as const;
/** Idle cycle: 4-step lookup into the 3-frame idleDown/idleUp arrays. */
export const PET_IDLE_SEQUENCE = [0, 1, 2, 1] as const;
/** Minimum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MIN_SEC = 3.0;
/** Maximum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MAX_SEC = 15.0;
/** Seconds between FOLLOW path re-computations. */
export const PET_FOLLOW_RECALC_INTERVAL_SEC = 1.0;
/** Probability that a pet enters FOLLOW (instead of WALK) when wanderTimer expires. */
export const PET_FOLLOW_CHANCE = 0.3;
/** Maximum Manhattan distance (tiles) at which a character can become a follow target. */
export const PET_FOLLOW_RADIUS_TILES = 3;
/** Minimum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MIN_SEC = 5.0;
/** Maximum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MAX_SEC = 15.0;
/** Hit-box half-width (world px) for pet click detection. */
export const PET_HIT_HALF_WIDTH = 8;
/** Hit-box height (world px) measured upward from the bottom-center anchor. */
export const PET_HIT_HEIGHT = 16;
/** Zoom factor used to draw pet thumbnails in the EditorToolbar Pets tab. */
export const PET_THUMB_ZOOM = 2;
/** Scale margin so the pet thumbnail fills the ItemSelect cell without touching the edges. */
export const PET_THUMB_SCALE_MARGIN = 0.85;
/** Fallback background fill for sprite-less thumbnail (used while pet sprites are loading). */
export const EMPTY_SPRITE_THUMBNAIL_BG = '#333';
/** Maximum string length for a PlacedPet.id (defends against pathologically-long layout entries). */
export const MAX_PET_ID_LENGTH = 128;

// ── WebSocket reconnect (standalone only) ────────────────────
/** Reconnect backoff ladder shared by the /ws transport and every terminal
 *  socket (transport/reconnectBackoff.ts). The last rung repeats. */
export const WS_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

// ── Terminal drawer (standalone only) ────────────────────────

// This file is the one place inline colors are allowed (see eslint.config.js),
// which is why xterm's theme lives here rather than next to the component.

// The panel docks on the right as a full-height column, in flow beside the
// office region (which flexes to fill the rest) — not overlaid on top of it.
/** Open width the panel starts at, in px; the user can drag to resize. */
export const TERMINAL_DRAWER_DEFAULT_WIDTH_PX = 520;
/** Clamp for the drag: never narrower than this. */
export const TERMINAL_DRAWER_MIN_WIDTH_PX = 320;
/** Clamp for the drag: never wider than this fraction of the window. */
export const TERMINAL_DRAWER_MAX_WIDTH_RATIO = 0.8;
/** Width of the always-visible agent-card bar overlaying the office's right
 *  edge — fits the toggle handle and the stacked agent cards (40px mug shot +
 *  16px close/status column + card chrome ≈ 63px, plus a little air each
 *  side). */
export const TERMINAL_SIDEBAR_WIDTH_PX = 72;
/** Grab width of the drag handle on the panel's left edge. */
export const TERMINAL_DRAWER_RESIZE_HANDLE_PX = 6;

// Mug shot: a square crop of the agent's front-facing sprite, focused on the
// face, shown in each terminal tab in place of an "Agent N" label. Sprites are
// 16 wide × 32 tall; the head runs to about row 18 (eyes ~row 14). The square is
// wider than the 16px sprite, so the head sits centred with a little air.
// Tweak these three to reframe: SIDE = zoom out/in, TOP = raise/lower the crop,
// LEFT = shift left/right (negative centres a square wider than the sprite).
export const MUGSHOT_CROP_TOP_ROW = 0;
export const MUGSHOT_CROP_LEFT_COL = -1;
export const MUGSHOT_CROP_SIDE_PX = 20;
/** Integer sprite-pixel zoom. 2 = each sprite pixel is 2 px. */
export const MUGSHOT_RENDER_ZOOM = 2;
/** On-screen size in CSS px. Equal to the backing canvas (crop × zoom) so there
 *  is no fractional scaling — the mug shot stays pixel-perfect. */
export const MUGSHOT_DISPLAY_PX = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
/** Terminal CONTENT is monospace on purpose: FS Pixel Sans is not a mono font,
 *  and a TUI mis-renders in a proportional face. The drawer chrome around it
 *  still uses the pixel font. */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';
export const TERMINAL_FONT_SIZE_PX = 13;
/** Lines xterm retains client-side (independent of the server's replay ring). */
export const TERMINAL_SCROLLBACK_LINES = 5_000;
/** Debounce for propagating a resize to the PTY (fit on every frame thrashes it). */
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100;
/** URL schemes a click in the terminal pane may open (see terminalLinks.ts). */
export const TERMINAL_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:'];
/** window.open features for terminal links: no opener handle, no Referer. */
export const TERMINAL_LINK_WINDOW_FEATURES = 'noopener,noreferrer';
/** THE plain-URL pattern of the terminal pane: TerminalPane hands it to
 *  @xterm/addon-web-links (`urlRegex`) for mouse clicks and urlAtCell matches
 *  it for touch taps, so a URL that is clickable is exactly one that is
 *  tappable. Equivalent to the addon's built-in strictUrlRegex. Deliberately
 *  NOT global: the addon rebuilds it as `new RegExp(source, flags + 'g')`, so
 *  a `g` here would throw on the duplicate flag; matchAll callers make their
 *  own global copy. */
export const TERMINAL_URL_PATTERN =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
/** Largest OSC 52 clipboard write the terminal honours (clipboardKeys.ts),
 *  in base64 characters (~3 MB of text). Bigger ones are dropped rather than
 *  decoded: a runaway program shouldn't be able to stall the page. */
export const TERMINAL_OSC52_MAX_BASE64_CHARS = 4_000_000;

/** xterm theme, matched to the office palette (index.css :root). */
export const TERMINAL_THEME = {
  background: '#181828',
  foreground: 'rgba(255, 255, 255, 0.9)',
  cursor: '#6030ff',
  cursorAccent: '#181828',
  selectionBackground: 'rgba(96, 48, 255, 0.4)',
  black: '#1e1e2e',
  red: '#d14249',
  green: '#89d185',
  yellow: '#cca700',
  blue: '#3794ff',
  magenta: '#746fff',
  cyan: '#4ad9d9',
  white: 'rgba(255, 255, 255, 0.9)',
  brightBlack: '#4a4a6a',
  brightRed: '#ff6b72',
  brightGreen: '#a8e5a4',
  brightYellow: '#ffd700',
  brightBlue: '#66aaff',
  brightMagenta: '#a29bff',
  brightCyan: '#7fe8e8',
  brightWhite: '#ffffff',
} as const;

// ── Mobile shell ─────────────────────────────────────────────
// Below this the app swaps the desktop drawer layout for the mobile shell:
// office and terminal as full-screen pages in a sliding track, with the agent
// cards in a bottom scroller. Phones match the first clause in either
// orientation; the second catches touch tablets (iPad portrait/landscape)
// where the drag-to-resize drawer is unusable anyway.
export const MOBILE_MEDIA_QUERY = '(max-width: 768px), ((pointer: coarse) and (max-width: 1024px))';
/** Slide duration between the office and terminal pages. */
export const MOBILE_VIEW_TRANSITION_MS = 300;
/** Width of the screen-edge strips that arm the view-switch swipe: right
 *  edge in office view (swipe left → terminal), left edge in terminal view
 *  (swipe right → office). */
export const MOBILE_EDGE_SWIPE_ZONE_PX = 24;
/** Horizontal movement that claims an armed edge touch as a view swipe; it
 *  must also dominate the vertical axis, or the touch is handed back. */
export const MOBILE_EDGE_SWIPE_SLOP_PX = 8;
/** Fraction of the page width past which a released swipe commits. */
export const MOBILE_EDGE_SWIPE_COMMIT_RATIO = 0.35;
/** Release velocity (px/ms) that commits a swipe regardless of distance. */
export const MOBILE_EDGE_SWIPE_COMMIT_VELOCITY = 0.3;
/** Weight of the newest sample in the swipe's smoothed release velocity
 *  (the rest carries over from the previous estimate). */
export const MOBILE_EDGE_SWIPE_VELOCITY_WEIGHT = 0.8;
/** Slightly smaller than the desktop 13px: a 390px phone fits ~46 columns at
 *  13px but ~50 at 12px, and Claude Code's TUI degrades below ~45 columns. */
export const MOBILE_TERMINAL_FONT_SIZE_PX = 12;

// ── Touch input (every surface) ──────────────────────────────
/** Tap slop shared by every touch surface (withinTapSlop): a finger that
 *  travels less than this from where it landed is still a tap; beyond it the
 *  gesture becomes that surface's drag (pan, scroll, reorder). */
export const TOUCH_TAP_MAX_MOVE_PX = 10;
/** A press longer than this is not a tap even if the finger never moved. */
export const TOUCH_TAP_MAX_DURATION_MS = 350;

// ── Terminal touch (touchGesture.ts, selectionOverlay.ts, flowCopy.ts) ──
/** Hold a finger within the tap slop for this long on the terminal to start
 *  text selection instead of scrolling: the word under the finger is
 *  selected, and dragging then extends the selection cell by cell. */
export const TERMINAL_LONG_PRESS_MS = 500;
/** Vertical gap between the selection's top row and the floating copy pill
 *  hovering above it (clears the start handle's knob). */
export const TERMINAL_COPY_PILL_GAP_PX = 56;
/** The copy pill's center stays at least this far from the pane's left and
 *  right edges — or half its measured width, when that is more — so it is
 *  never clipped. */
export const TERMINAL_COPY_PILL_EDGE_INSET_X_PX = 44;
/** The copy pill's top stays at least this far above the pane's bottom edge
 *  (its own height plus a margin). */
export const TERMINAL_COPY_PILL_BOTTOM_CLEARANCE_PX = 48;
/** The copy pill's top never goes above this; a pill that would (selection
 *  near the top of the pane) drops below the selection instead. */
export const TERMINAL_COPY_PILL_MIN_TOP_PX = 4;
/** Gap below the selection's last row when the pill drops beneath it (clears
 *  the end handle's knob). */
export const TERMINAL_COPY_PILL_BELOW_OFFSET_PX = 16;
/** Width of a selection handle's touch strip, centered on the selection edge.
 *  Feeds the `.terminal-sel-handle` CSS through --sel-handle-w. */
export const TERMINAL_SEL_HANDLE_WIDTH_PX = 24;
/** Side of a selection handle's square knob (above the start bar, below the
 *  end bar). Feeds the `.terminal-sel-handle` CSS through --sel-knob. */
export const TERMINAL_SEL_HANDLE_KNOB_PX = 12;
/** Copy-flowing (flowCopy.ts) judges "the next word would not have fit on
 *  the row above" against `cols` minus this: Claude Code wraps prose a few
 *  columns short of the terminal width (its own gutters). Too small and real
 *  soft wraps stay broken; too large and short deliberate lines get joined. */
export const TERMINAL_COPY_WRAP_SLACK_COLS = 4;
/** Flick decay after a terminal touch-scroll release, applied per millisecond
 *  of frame time (0.998 ≈ iOS UIScrollView's normal deceleration rate). */
export const TERMINAL_FLICK_DECAY_PER_MS = 0.998;
/** Release velocity (px/ms) below which no flick starts and at which a
 *  running flick stops. */
export const TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS = 0.05;
/** Exponential smoothing of the touch-scroll velocity: weight of the newest
 *  move's sample (the running value keeps the rest). The release velocity
 *  comes from the last move event, which is noisy on its own. */
export const TERMINAL_FLICK_VELOCITY_SMOOTHING = 0.8;
/** xterm's cell-grid element: hit-testing, row height and the selection
 *  chrome all measure THIS rect (not the host, which keeps up to a row of
 *  slack below the grid after fit). */
export const XTERM_SCREEN_SELECTOR = '.xterm-screen';
/** Class of xterm's hidden input textarea — focused while typing into a
 *  terminal (see isTypingInTerminal). */
export const XTERM_HELPER_TEXTAREA_CLASS = 'xterm-helper-textarea';

// ── Mobile card bar (MobileAgentBar) ─────────────────────────
/** Holding a card motionless this long arms drag-to-reorder in the mobile bar. */
export const CARD_REORDER_LONG_PRESS_MS = 400;
/** Holding a drawer's Directory row this long opens its edit modal — the touch
 *  stand-in for the pencil, which only exists where rows can be hovered. */
export const DRAWER_EDIT_LONG_PRESS_MS = 500;
/** Finger slop for that hold: moving beyond this is a scroll, not a press. */
export const DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX = 10;
/** Gap a viewport-fitted Dropdown (the launch drawer) keeps from the top of
 *  the viewport when its content is taller than the room above its anchor. */
export const DROPDOWN_VIEWPORT_MARGIN_PX = 8;
/** localStorage key for the mobile bar's custom card order (per device — a
 *  presentation preference, deliberately not synced through the server). */
export const MOBILE_CARD_ORDER_STORAGE_KEY = 'pixel-agents.mobileCardOrder';
/** Breathing room kept between a card and the scroller edge when the bar
 *  auto-scrolls the focused agent's card into view. */
export const CARD_SCROLL_INTO_VIEW_MARGIN_PX = 8;

// ── Mobile key bar (MobileKeyBar) ────────────────────────────
/** Arrow-key byte sequences the trackpad key writes to the PTY. */
export const TERMINAL_SEQ_ARROW_UP = '\x1b[A';
export const TERMINAL_SEQ_ARROW_DOWN = '\x1b[B';
export const TERMINAL_SEQ_ARROW_RIGHT = '\x1b[C';
export const TERMINAL_SEQ_ARROW_LEFT = '\x1b[D';
/** Accessory keys shown above the iOS keyboard in terminal view — the keys a
 *  Claude Code TUI needs that the software keyboard lacks. `sequence` is the
 *  raw bytes written to the PTY: shift+tab is CSI Z (back-tab). */
export const MOBILE_KEY_BAR_KEYS: ReadonlyArray<{
  label: string;
  /** Byte sequence a tap writes to the PTY. Absent on the trackpad key — a
   *  plain tap there deliberately does nothing. */
  sequence?: string;
  /** Press-hold-slide emits arrow keys with the finger in all four
   *  directions, echoing the iOS space-bar trackpad (whose real caret
   *  gesture can't reach xterm — its textarea must stay empty for input
   *  diffing). Drives Claude Code's TUI menus (/resume, /model) and the
   *  input-line cursor; the iOS keyboard has no arrows of its own. */
  trackpad?: boolean;
}> = [
  { label: '/', sequence: '/' },
  { label: 'shift+tab', sequence: '\x1b[Z' },
  { label: 'esc', sequence: '\x1b' },
  { label: '✜', trackpad: true },
  // Line break without submitting: Claude Code's backslash+Enter escape —
  // its universal form (shift+enter needs a /terminal-setup rebind that
  // can't exist on a phone keyboard).
  { label: '↵', sequence: '\\\r' },
];
/** Finger travel per emitted arrow while sliding on the trackpad key. */
export const MOBILE_TRACKPAD_STEP_PX = 16;
/** The paste key's prompt where script can't read the clipboard (plain-http
 *  origins): the user pastes into the native field instead. */
export const MOBILE_PASTE_PROMPT = 'Paste into the terminal:';
/** visualViewport.height within this many px of innerHeight = nothing to
 *  clamp (the two disagree by sub-pixel rounding on some devices). */
export const VISUAL_VIEWPORT_FULL_EPSILON_PX = 1;
/** The visual viewport this far below the tallest seen at the current width
 *  (with an editable focused) = the software keyboard is up. Well above an
 *  address bar collapsing (~56 px), well below any on-screen keyboard. */
export const KEYBOARD_MIN_HEIGHT_PX = 150;

// ── Useful signals (docs/office/DESIGN.md, phase D) ─────────────
/** Desk fire: seconds per FIRE_ICON ON frame. */
export const FIRE_ICON_FRAME_SEC = 0.25;
/** Alarm lamp: seconds per OFF/ON half of a blink. */
export const ALARM_LAMP_BLINK_SEC = 0.5;
/** Trouble icons stand this many sprite px past the desk tile's edge nearest the
 *  desk's top (the far edge for a desk below the seat, the near one for a desk above). */
export const TROUBLE_ICON_DESK_DROP_PX = 4;
/** ...and this far beside the tile's middle, clear of a centred monitor. */
export const TROUBLE_ICON_SIDE_PX = 8;
/** The timeline card and the notice board's list: above the labels and bubbles. */
export const SIGNAL_POPUP_Z_INDEX = 50;
/** The loop line on a label. */
export const LOOP_LABEL_TEXT = '🌀 going in circles?';
/** The alarm's line on a label (3+ failures in a row). */
export const STUCK_LABEL_TEXT = '🚨 stuck?';
/** Timeline card: rows shown (the server keeps 20). */
export const TIMELINE_CARD_ROWS = 10;
/** Timeline card: width on desktop, CSS px. */
export const TIMELINE_CARD_WIDTH_PX = 300;
/** Timeline card: gap between the character and the card, CSS px. */
export const TIMELINE_CARD_GAP_PX = 24;
/** Notice board sprite type (office pack, a wall item). */
export const NOTICE_BOARD_TYPE = 'NOTICE_BOARD';
/** The board's cork, in sprite px from its top-left. */
export const NOTICE_BOARD_CORK = { x: 5, y: 9, w: 22, h: 16 } as const;
/** Lines of tiny text drawn on the cork. */
export const NOTICE_BOARD_LINES = 5;
/** Ink on the cork. */
export const NOTICE_BOARD_INK = '#2a1a0e';
/** A pinned note's paper behind each line. */
export const NOTICE_BOARD_PAPER = 'rgba(250, 244, 222, 0.85)';

// ── Fun (phases E/F, see src/fun/): colours ──────────────────────
export const FUN_CALENDAR_PR_COLOR = '#4caf50';
export const FUN_CALENDAR_PR_STREAK_COLOR = '#2e7d32';
export const FUN_CALENDAR_TODAY_COLOR = '#f0cc58';
export const FUN_CALENDAR_TEXT_COLOR = '#fff1e8';
export const FUN_WEATHER_RAIN_COLOR = '#9cc4e8';
export const FUN_WEATHER_SNOW_COLOR = '#ffffff';
export const FUN_WEATHER_CLOUD_COLOR = '#7d8790';
export const FUN_WEATHER_FOG_COLOR = '#d6d7d8';
export const FUN_WEATHER_FLASH_COLOR = '#fff8d0';
export const FUN_RADIO_NOTE_COLORS: readonly string[] = [
  '#f0cc58',
  '#8fb6d6',
  '#e58fb0',
  '#9fd98f',
];
export const FUN_PING_PONG_BALL_COLOR = '#ffffff';
export const FUN_PING_PONG_PADDLE_COLOR = '#c0392b';
export const FUN_PING_PONG_HANDLE_COLOR = '#6b4a2b';
export const FUN_DIM_PULSE_COLOR = '#000000';
export const FUN_BANNER_BG = 'rgba(30, 30, 46, 0.9)';
export const FUN_BANNER_BORDER_COLOR = '#f0cc58';
export const FUN_BANNER_TEXT_COLOR = '#fff1e8';

// ── Subscription usage meter (server room wall display, see src/usage/) ──
/** The display's height, in sprite px: two 10 px rows (it overhangs the wall
 *  above the racks a little, for text that stays readable zoomed out). */
export const USAGE_METER_HEIGHT_SPRITE_PX = 20;
/** Widest the display grows, in tiles (a wide server room keeps a panel). */
export const USAGE_METER_MAX_WIDTH_TILES = 8;
/** At or above this % used, the bar turns amber... */
export const USAGE_METER_WARN_PERCENT = 60;
/** ...and at or above this, red. */
export const USAGE_METER_HIGH_PERCENT = 85;
export const USAGE_METER_BG = '#10141c';
export const USAGE_METER_FRAME = '#3a4a5c';
export const USAGE_METER_TRACK = '#232c38';
export const USAGE_METER_OK = '#5fc9b0';
export const USAGE_METER_WARN = '#f0cc58';
export const USAGE_METER_HIGH = '#e05a4f';
export const USAGE_METER_TEXT = '#d8f5ec';
export const USAGE_METER_DIM_TEXT = '#7d8b99';
