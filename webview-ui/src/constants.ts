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
/** A helper (sub-agent) stays within this many tiles of its lead, any direction. */
export const HELPER_FOLLOW_RADIUS_TILES = 2;
/** A helper between two tool calls keeps sitting; it stands only after waiting this long. */
export const HELPER_STAND_UP_DELAY_SEC = 3;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;
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
/** Office blinks, per character on its own clock. A gap is BLINK_GAP_MIN_SEC plus a random
 *  wait that is usually short and now and then long (exponential, mean BLINK_GAP_MEAN_SEC,
 *  capped at BLINK_GAP_MAX_SEC), stretched by BLINK_FOCUS_STRETCH while working at the desk
 *  (people blink less when they concentrate). BLINK_DOUBLE_CHANCE of blinks come twice. */
export const BLINK_SHUT_SEC = [0.1, 0.17] as const;
export const BLINK_GAP_MIN_SEC = 1.5;
export const BLINK_GAP_MEAN_SEC = 3.5;
export const BLINK_GAP_MAX_SEC = 11;
export const BLINK_FOCUS_STRETCH = 1.5;
export const BLINK_DOUBLE_CHANCE = 0.15;
export const BLINK_DOUBLE_GAP_SEC = [0.15, 0.3] as const;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
/** The selected furniture's rotate / delete buttons, in CSS pixels (drawn in
 *  whole device pixels): the toolbar's 8×8 icons at their scale, padded. */
export const SELECTION_BUTTON_ICON_SCALE = 2;
export const SELECTION_BUTTON_PADDING_PX = 4;
/** Their hard shadow's offset, as on every pixel panel. */
export const SELECTION_BUTTON_SHADOW_PX = 2;
/** Space between the buttons, and between them and the item below. */
export const SELECTION_BUTTON_GAP_PX = 4;
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
/** --color-danger, --color-accent, --color-shadow (index.css): canvas can't read CSS variables. */
export const DELETE_BUTTON_BG = '#d14249';
export const ROTATE_BUTTON_BG = '#6030ff';
/** Hovered or pressed: a lighter danger red, and --color-accent-bright. */
export const DELETE_BUTTON_HOVER_BG = '#e3666c';
export const ROTATE_BUTTON_HOVER_BG = '#746fff';
export const BUTTON_ICON_COLOR = '#ffffff';
export const BUTTON_SHADOW_COLOR = '#0a0a14';
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
export const PAN_MARGIN_FRACTION = 0.25;

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
/** The hex field's border + left padding: where its pixel-font copy starts. */
export const VISUAL_COLOR_PICKER_HEX_INSET_PX = 2 + 2;
/** The Characters colour panel's hex field: border + left padding (.chv-pick-hex). */
export const CHARACTER_HEX_INSET_PX = 2 + 6;
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

// ── Furniture Animation ─────────────────────────────────────
export const FURNITURE_ANIM_INTERVAL_SEC = 0.2;

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
/** World px from a character's feet to its sprite's top edge (the tallest hair). */
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;
/** CSS px between the label's bottom and the sprite's top edge (or the bubble
 *  over it). Negative: most hair stops a little below that edge. */
export const TOOL_OVERLAY_GAP_PX = -2;

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** The character the greeter wears, by its permanent profile id: the default
 *  cast's Suit (the first in the cast if no character has that id). An id, not
 *  a name, so renaming the character doesn't change who greets. */
export const GREETER_CHARACTER_ID = 'char-0';
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** ToolOverlay stacking: status label panels (selected one on top), then the
 *  characters' speech bubbles above every label. Local to the office layer
 *  (App wraps ToolOverlay in a z-0 box), so they never rise above the UI. */
export const OVERLAY_LABEL_Z_INDEX = 41;
export const OVERLAY_LABEL_SELECTED_Z_INDEX = 42;
export const OVERLAY_BUBBLE_Z_INDEX = 43;
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;
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
/** The gauge's colour steps by share USED, as the user's Claude Code status
 *  line colours its context bar: green under a third, yellow to two thirds,
 *  red past it. */
export const CONTEXT_YELLOW_THRESHOLD = 0.33;
export const CONTEXT_RED_THRESHOLD = 0.66;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
/** Space between an agent's label and its context gauge. */
export const CONTEXT_GAUGE_GAP_PX = 4;
/** The context bar along the foot of each agent card. */
export const CARD_CONTEXT_BAR_HEIGHT_PX = 3;
/** A card's mug shot starts this many sprite rows down (the shared default is
 *  0): the character sits higher, a little air above the head, clear of the
 *  context bar along the card's foot. */
export const CARD_MUGSHOT_CROP_TOP_ROW = 1;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
/** The usage bars' yellow (the weekly bar at half or less). */
export const CONTEXT_GAUGE_COLOR_YELLOW = 'var(--color-status-permission)';
export const CONTEXT_GAUGE_COLOR_RED = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

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
/** How long a launch (or resume) this client sent waits for its terminal:
 *  the next terminal to open within this answers it and comes in focused.
 *  A spawn that fails never opens one, and no message says so, so the wait
 *  ends here rather than claiming the next terminal some other device opens. */
export const LAUNCH_ANSWER_TIMEOUT_MS = 10_000;
/** The hide ribbon below the cards: its width at rest, as a share of a
 *  card's (hovered, it reaches the cards' left edge). */
export const TERMINAL_HIDE_RIBBON_REST_RATIO = 0.75;

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
/** A Directory's default characters, inline in the launch drawer: mug shots
 *  side by side at 1x (one sprite pixel per CSS pixel). One more than this all
 *  show; past that, this many and a "..." silhouette for the rest. */
export const DIRECTORY_STRIP_MAX = 3;
/** With every default shown (the "..." pressed), mug shots per line before
 *  the strip wraps, so a long list makes the row taller, not the drawer wider. */
export const DIRECTORY_STRIP_PER_LINE = 6;
/** Empty columns right of the head in the 20px crop: the strip's right margin
 *  takes them back, so the last head sits on the row's padding. */
export const DIRECTORY_STRIP_TRAILING_EMPTY_PX = 4;
/** Space between the launch drawer and the edit pencil hanging beside a row. */
export const LAUNCH_DRAWER_PENCIL_GAP_PX = 4;
/** The overflow silhouette: a blank character in a dark tone, with "..." over it. */
export const DIRECTORY_SILHOUETTE_COLOR = '#3a3a54';
export const DIRECTORY_SILHOUETTE_DOTS_COLOR = '#d0d0e4';
/** The "..." on it, in sprite pixels: three 2px dots 1px apart (columns 5–12),
 *  centred on the blank head (columns 2–15). */
export const DIRECTORY_SILHOUETTE_DOT_PX = 2;
export const DIRECTORY_SILHOUETTE_DOT_Y = 8;
export const DIRECTORY_SILHOUETTE_DOT_XS = [5, 8, 11] as const;
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
/** THE plain-URL pattern of the terminal pane: one lookup (urlsOnLine) serves
 *  mouse clicks and touch taps, so a URL that is clickable is exactly one that
 *  is tappable. Equivalent to @xterm/addon-web-links' strictUrlRegex. Not
 *  global; matchAll callers make their own global copy. */
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
/** How far from the cursor row the input area's ruled edges are looked for
 *  (a long multi-line prompt can sit this many rows above or below it). */
export const TERMINAL_INPUT_AREA_MAX_SCAN_ROWS = 20;
/** A row is a rule (the prompt box's top or bottom edge) when at least this
 *  many of its non-space characters are box-drawing lines… */
export const TERMINAL_RULE_MIN_CHARS = 8;
/** …and they make up at least this share of them. */
export const TERMINAL_RULE_MIN_SHARE = 0.8;
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

// ── Agent card bars (AgentCardList) ──────────────────────────
/** Holding a card motionless this long arms touch drag-to-reorder. */
export const CARD_REORDER_LONG_PRESS_MS = 400;
/** Holding a drawer's Directory row (or a roster card) this long opens its
 *  editor (useLongPress) — the touch stand-in for the pencil, which only exists
 *  where rows can be hovered. */
export const EDIT_LONG_PRESS_MS = 500;
/** Finger slop for that hold: moving beyond this is a scroll, not a press. */
export const EDIT_LONG_PRESS_MAX_MOVE_PX = 10;

/** CSS pixels per sprite pixel on the phone roster's character cards. */
export const CHARACTER_PICKER_SPRITE_SCALE = 2;
/** Gap a viewport-fitted Dropdown (the launch drawer) keeps from the top of
 *  the viewport when its content is taller than the room above its anchor. */
export const DROPDOWN_VIEWPORT_MARGIN_PX = 8;
/** How long a toolbar menu (or modal) takes to roll shut: keep it equal to
 *  the menu-pop-out / modal-pop-out durations in index.css. */
export const MENU_POP_OUT_MS = 130;
/** The desktop roster, opened by hovering its arrow, stays this long after the
 *  pointer leaves (arrow and roster both), so it can cross the gap between. */
export const ROSTER_HOVER_CLOSE_DELAY_MS = 250;
/** Breathing room kept between a card and the scroller edge when the bar
 *  auto-scrolls the focused agent's card into view. */
export const CARD_SCROLL_INTO_VIEW_MARGIN_PX = 8;

// ── Mobile key bar (MobileKeyBar) ────────────────────────────
/** Arrow-key byte sequences the trackpad key writes to the PTY. */
export const TERMINAL_SEQ_ARROW_UP = '\x1b[A';
export const TERMINAL_SEQ_ARROW_DOWN = '\x1b[B';
export const TERMINAL_SEQ_ARROW_RIGHT = '\x1b[C';
export const TERMINAL_SEQ_ARROW_LEFT = '\x1b[D';
/** Arrow key → the bytes it writes to the PTY (the key bar's trackpad). */
export const TERMINAL_ARROW_SEQUENCES = {
  up: TERMINAL_SEQ_ARROW_UP,
  down: TERMINAL_SEQ_ARROW_DOWN,
  left: TERMINAL_SEQ_ARROW_LEFT,
  right: TERMINAL_SEQ_ARROW_RIGHT,
} as const;
/** Accessory keys shown above the iOS keyboard in terminal view — the keys a
 *  Claude Code TUI needs that the software keyboard lacks. Each key's
 *  `sequence` is the raw bytes a tap writes to the PTY: shift+tab is CSI Z
 *  (back-tab). The trackpad sits in the middle of the bar: the `left` keys
 *  fill the left half, the `right` keys the right. */
export const MOBILE_KEY_BAR: {
  left: ReadonlyArray<{ label: string; sequence: string }>;
  /** Press-hold-slide emits arrow keys with the finger, along the first
   *  direction it moves in (touch/trackpad.ts), echoing the iOS space-bar
   *  trackpad (whose real caret gesture can't reach xterm — its textarea
   *  must stay empty for input diffing). Drives Claude Code's TUI menus (/resume, /model) and the
   *  input-line cursor; the iOS keyboard has no arrows of its own. A plain
   *  tap on it deliberately does nothing. */
  pad: { label: string };
  right: ReadonlyArray<{ label: string; sequence: string }>;
} = {
  left: [
    { label: '/', sequence: '/' },
    // The iOS keyboard has no tab key: Claude Code completes paths and
    // commands with it.
    { label: 'tab', sequence: '\t' },
    { label: 'shift+tab', sequence: '\x1b[Z' },
  ],
  pad: { label: 'Arrow keys' },
  right: [
    { label: 'esc', sequence: '\x1b' },
    // Forward delete: the iOS keyboard's ⌫ only deletes backwards.
    { label: 'del', sequence: '\x1b[3~' },
    // Line break without submitting: Claude Code's backslash+Enter escape —
    // its universal form (shift+enter needs a /terminal-setup rebind that
    // can't exist on a phone keyboard).
    { label: '↵', sequence: '\\\r' },
  ],
};
/** The trackpad key's slide (touch/trackpad.ts): finger travel per left/right
 *  arrow (twice as fast as up/down: a line has far more columns than a menu
 *  has rows), per up/down arrow, the travel from a pivot that picks the axis,
 *  and the speed (px/ms, i.e. 100 px/s) below which the finger is resting — a
 *  rest is a new pivot, where the slide may switch axis. */
export const MOBILE_TRACKPAD = {
  stepX: 8,
  stepY: 16,
  decidePx: 16,
  pauseSpeed: 0.1,
} as const;
/** How long the trackpad's arrows nudge toward each arrow it sends. */
export const MOBILE_TRACKPAD_NUDGE_MS = 90;
/** The Paste pill's prompt where script can't read the clipboard (plain-http
 *  origins): the user pastes into the native field instead. */
export const MOBILE_PASTE_PROMPT = 'Paste into the terminal:';
/** visualViewport.height within this many px of innerHeight = nothing to
 *  clamp (the two disagree by sub-pixel rounding on some devices). */
export const VISUAL_VIEWPORT_FULL_EPSILON_PX = 1;
/** The visual viewport this far below the tallest seen at the current width
 *  (with an editable focused) = the software keyboard is up. Well above an
 *  address bar collapsing (~56 px), well below any on-screen keyboard. */
export const KEYBOARD_MIN_HEIGHT_PX = 150;

// ── Characters view ─────────────────────────────────────────
/** Stacking order for the Characters view: over the whole office UI and every
 *  modal (ui/Modal 50, ChangelogModal 51, the hooks notice 52), since it is
 *  opened from them and takes the screen while it is up. */
export const CHARACTERS_VIEW_Z_INDEX = 60;
/** How long a status line stays up (it also clears on the next press). */
export const CHARACTERS_STATUS_MS = { ok: 2500, err: 6000 } as const;
/** A destructive button (Clear frame, Remove) acts on a second press within this long. */
export const CHARACTERS_ARM_MS = 2500;
/** Desktop preview sizing: the export sheet's CSS px per sprite pixel stays in this
 *  range, the big preview figure is HERO_PER_SHEET times it (never under HERO_MIN_SCALE;
 *  the four turn figures match the sheet), and the wardrobe keeps MIN_WARDROBE_W px. */
export const CHARACTERS_SHEET_SCALE = { min: 1.5, max: 3 } as const;
export const CHARACTERS_HERO_PER_SHEET = 8 / 3;
export const CHARACTERS_HERO_MIN_SCALE = 3;
export const CHARACTERS_MIN_WARDROBE_W = 420;
/** Phone preview figures (CSS px per sprite pixel); the sheet fits its box, at least
 *  `sheetMinDevicePx` device pixels per sprite pixel. */
export const CHARACTERS_PHONE_SCALES = { hero: 4, turn: 2, sheetMinDevicePx: 1 } as const;
/** Pixel editor scale: as big as fits; desktop within deskMin-deskMax CSS px per sprite
 *  pixel, phones at least phoneMinDevicePx device pixels. */
export const CHARACTER_EDITOR_SCALE = { deskMin: 6, deskMax: 14, phoneMinDevicePx: 4 } as const;
/** Preview animation: ms per frame of each loop, and the blink (shut BLINK_MS
 *  every BLINK_GAP_MS[0]-[1] ms, the first after BLINK_FIRST_MS). */
export const CHARACTER_ANIM_MS = { walk: 150, type: 300, read: 600 } as const;
export const CHARACTER_BLINK_MS = 150;
export const CHARACTER_BLINK_GAP_MS = [2000, 6000] as const;
export const CHARACTER_BLINK_FIRST_MS = 2500;
/** Canvas colours of the pixel editor and the export sheet. Canvas code can't read
 *  CSS tokens, so the ones that match a token repeat its value (named alongside). */
export const CHARACTER_EDITOR_COLORS = {
  /** = --color-bg-thumb */
  checkerLight: '#2a2a3a',
  checkerDark: '#232334',
  grid: 'rgba(255, 255, 255, 0.07)',
  hover: '#ffffff',
  /** Marks a frame that has edits on the sheet (= --color-warning). */
  edited: '#ff8d14',
  /** Outlines the frame being edited on the sheet (= --color-accent-bright). */
  frame: '#746fff',
} as const;
/** The pencil's colour when a piece has none of its own. */
export const CHARACTER_PAINT_FALLBACK = '#000000';
/** The cast store: the office's sprites follow saved changes at most this often; changes
 *  this close merge into one undo step (unless a press groups them), and history keeps
 *  this many steps. */
export const CAST_OFFICE_SYNC_MS = 150;
export const CAST_HISTORY = { mergeMs: 500, limit: 100 } as const;
/** A repeated character's clothes colours, in order (characters/repeatClothes.ts):
 *  the nth repeat wears the nth, as a hue in degrees — red, blue, green, yellow,
 *  purple, cyan, pink, then orange, lime, indigo, teal, magenta; past the end it cycles. */
export const REPEAT_CLOTHES_HUES = [0, 220, 120, 55, 275, 185, 320, 28, 90, 245, 160, 340] as const;
/** Saturation (0-100) a repeat's clothes are colorized at, keeping each piece's shading. */
export const REPEAT_CLOTHES_SATURATION = 70;

// ── Pixel icons ─────────────────────────────────────────────
/** Screen pixels per icon pixel (whole number, so the icon stays crisp). */
export const PIXEL_ICON_SCALE = 2;

// ── Side panels docked beside the office (the terminal drawer, the conversation sidebar) ──
// Their motion: hooks/useSlidePanel.ts.
/** The conversation sidebar's width. */
export const CONVERSATION_SIDEBAR_WIDTH_PX = 260;
/** Opening: the panel stretches out a touch past its width and settles back. */
export const SIDE_PANEL_OPEN_MS = 340;
export const SIDE_PANEL_OPEN_EASE = 'cubic-bezier(0.34, 1.35, 0.64, 1)';
/** Its contents slide in once the panel is mostly out. */
export const SIDE_PANEL_CONTENT_DELAY_MS = 90;
/** Closing is quicker and doesn't bounce: contents fade first, the panel snaps shut. */
export const SIDE_PANEL_CLOSE_MS = 200;
export const SIDE_PANEL_CLOSE_EASE = 'cubic-bezier(0.55, 0, 0.75, 0.2)';
/** How far the contents travel as they slide in or out. */
export const SIDE_PANEL_CONTENT_SHIFT_PX = 24;
/** Agents coming and going in a burst (a reconnect) ask for the list once. */
export const CONVERSATIONS_REFRESH_DEBOUNCE_MS = 300;
/** While open, the list is re-asked this often: a running conversation gets its title. */
export const CONVERSATIONS_REFRESH_INTERVAL_MS = 30_000;
/** The phone's conversations panel: most of the screen, the office peeking beside it. */
export const MOBILE_CONVERSATIONS_WIDTH = 'min(340px, 85vw)';
/** Conversations in the list's "Recent" section, across every Directory. */
export const RECENT_CONVERSATIONS_COUNT = 5;
/** localStorage key: the Directory paths this viewer expanded in the conversation list. */
export const CONVERSATION_EXPANDED_KEY = 'pixel-agents.conversationExpandedDirectories';
/** localStorage key: whether this viewer shut the desktop conversation sidebar. */
export const CONVERSATION_SIDEBAR_SHUT_KEY = 'pixel-agents.conversationSidebarShut';
/** How long a Directory's section takes to unfold or fold in the conversation list. */
export const CONVERSATION_UNFOLD_MS = 180;
/** An agent card's height: its mug shot plus 1px padding and 2px border each
 *  side. The phone's + card (square) and the roster's arrow (a narrow tab)
 *  are sized from it, so the bar's first card lines up with the rest. */
export const AGENT_CARD_HEIGHT_PX = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM + 2 * (1 + 2);
/** An agent card's width: its mug shot, the 1px gap, the close/status column
 *  (one 8×8 PixelIcon wide), and 1px padding and 2px border each side. */
export const AGENT_CARD_WIDTH_PX =
  MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM + 1 + 8 * PIXEL_ICON_SCALE + 2 * (1 + 2);
/** The roster arrow: a narrow tab right of the + card (phone bar and desktop toolbar). */
export const ROSTER_ARROW_WIDTH_PX = 28;

// ── Usage bars (top-left: the account's Claude Code plan usage) ──
/** Width of both bars: the weekly one on top, the 5-hour one under it. */
export const USAGE_BAR_WIDTH_PX = 150;
/** The heart's pace with the whole weekly plan left; it slows in proportion
 *  as the plan runs down, and stops when it is empty. */
export const USAGE_HEART_MAX_BPM = 100;
/** Both bars' height (told apart by colour, not size); the share left is printed inside. */
export const USAGE_BAR_HEIGHT_PX = 16;
/** The heart's colours, by the letters of its art (usage/PixelHeart.tsx):
 *  outline, red, shade and highlight. */
export const USAGE_HEART_COLORS: Record<string, string> = {
  o: '#14101c',
  r: '#e8283c',
  d: '#a8142c',
  w: '#ffffff',
};
/** At or below this share left, a bar turns the warning colour. */
export const USAGE_BAR_WARN_FRACTION = 0.5;
/** At or below this share left, a bar turns the danger colour. */
export const USAGE_BAR_LOW_FRACTION = 0.2;
/** How often the bars re-read the clock (resets and "updated N ago" move with it). */
export const USAGE_BAR_TICK_MS = 30_000;
/** Distance from the office's left edge: past the 40px button column at left 8. */
export const USAGE_BARS_LEFT_PX = 8 + 40 + 8;
/** The provider whose plan the usage bars show (the one with a usage bridge today). */
export const USAGE_PROVIDER_ID = 'claude';

// ── Loading screen (a lamp-lit corner of the office while it loads) ──
/** The loading screen's zoom, as the office counts it: DEVICE pixels per
 *  sprite pixel (the office at 5x on the phone, 3x on desktop). */
export const LOADING_ZOOM = 5;
export const LOADING_ZOOM_DESKTOP = 3;
/** The loading screen's background: the dark room the scene's floor fades into. */
export const LOADING_SCREEN_BG = '#000000';
/** The scene's floor: the office's wood planks in the default layout's colour (colorize). */
export const LOADING_FLOOR_COLOR = { h: 25, s: 48, b: -43, c: -88 } as const;
/** How far the floor's vignette darkens it into the background, at its edge (0-1). */
export const LOADING_VIGNETTE_DARKEST = 0.6;
/** Gradient stops along the floor's fade and vignette (both eased). */
export const LOADING_FADE_STOPS = 8;
/** Black at `alpha`: the floor's fade and vignette masks (only alpha matters). */
export const loadingShade = (alpha: number): string => `rgba(0, 0, 0, ${alpha})`;
/** "Loading the office": a dot more every step, up to three, then none again. */
export const LOADING_DOTS_MS = 400;
export const LOADING_MAX_DOTS = 3;

// ── Office radio (procedural 8-bit background music, music/) ──
/** How far ahead of the audio clock notes are scheduled. */
export const MUSIC_LOOKAHEAD_SEC = 0.2;
/** Lookahead while the tab is hidden, where timers can run late. */
export const MUSIC_LOOKAHEAD_HIDDEN_SEC = 1.5;
/** The scheduler's tick. */
export const MUSIC_TICK_MS = 25;
/** How long a skipped tune takes to fade out. */
export const MUSIC_SKIP_FADE_SEC = 0.25;
/** A low-pass over the whole mix that rounds off the square waves. */
export const MUSIC_TONE_CUTOFF_HZ = 4000;
/** Starting volume, 0-1. */
export const MUSIC_DEFAULT_VOLUME = 0.45;
/** A new tune's name won't repeat any of this many before it (it rerolls up to MUSIC_NAME_REROLLS times). */
export const MUSIC_RECENT_NAMES = 12;
export const MUSIC_NAME_REROLLS = 8;
/** localStorage key for the radio's volume and mood (per browser). */
export const MUSIC_STORAGE_KEY = 'pixel-agents.radio';
/** The compact player's width. */
export const MUSIC_PLAYER_WIDTH_PX = 364;
/** The player's visualizer: how many bars, and the band of the mix they span. */
export const MUSIC_VISUALIZER_BARS = 14;
export const MUSIC_VISUALIZER_LOW_HZ = 70;
export const MUSIC_VISUALIZER_HIGH_HZ = 4500;
/** The tallest visualizer bar and the volume slider's track, in CSS px. */
export const MUSIC_VISUALIZER_HEIGHT_PX = 20;
export const MUSIC_VOLUME_SLIDER_HEIGHT_PX = 88;
/** Gap between the player and the office's foot. */
export const MUSIC_PLAYER_BOTTOM_PX = 10;
/** Phone: a release faster than this (px/ms) settles the player the way it was flicked. */
export const MUSIC_FLICK_PX_PER_MS = 0.4;
/** Phone: a release slower than this long ago (ms) counts as no flick. */
export const MUSIC_FLICK_MAX_AGE_MS = 100;
/** Phone: how long the player takes to settle open or shut after a release or a tap. */
export const MUSIC_SHEET_SETTLE_MS = 220;
export const MUSIC_SHEET_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** Gap between the player's bar and the version label riding above it. */
export const MUSIC_VERSION_GAP_PX = 6;
/** The version label's spot in the office's bottom-right corner, with no player under it. */
export const VERSION_LABEL_BOTTOM_PX = 10;
/** The update notice / changelog tooltip, this far above the label's spot. */
export const VERSION_NOTICE_ABOVE_PX = 34;
