/**
 * Constants for the fun phase (docs/office/DESIGN.md, phases E and F). Kept
 * beside the modules that use them rather than in the shared constants.ts —
 * except the colours, which the lint rule keeps in constants.ts (re-exported).
 */

export {
  FUN_BANNER_BG as BANNER_BG,
  FUN_BANNER_BORDER_COLOR as BANNER_BORDER_COLOR,
  FUN_BANNER_TEXT_COLOR as BANNER_TEXT_COLOR,
  FUN_CALENDAR_PR_COLOR as CALENDAR_PR_COLOR,
  FUN_CALENDAR_PR_STREAK_COLOR as CALENDAR_PR_STRONG_COLOR,
  FUN_CALENDAR_TEXT_COLOR as CALENDAR_TEXT_COLOR,
  FUN_CALENDAR_TODAY_COLOR as CALENDAR_TODAY_COLOR,
  FUN_DIM_PULSE_COLOR as DIM_PULSE_COLOR,
  FUN_PING_PONG_BALL_COLOR as PING_PONG_BALL_COLOR,
  FUN_PING_PONG_HANDLE_COLOR as PING_PONG_HANDLE_COLOR,
  FUN_PING_PONG_PADDLE_COLOR as PING_PONG_PADDLE_COLOR,
  FUN_RADIO_NOTE_COLORS as RADIO_NOTE_COLORS,
  FUN_WEATHER_CLOUD_COLOR as WEATHER_CLOUD_COLOR,
  FUN_WEATHER_FLASH_COLOR as WEATHER_FLASH_COLOR,
  FUN_WEATHER_FOG_COLOR as WEATHER_FOG_COLOR,
  FUN_WEATHER_RAIN_COLOR as WEATHER_RAIN_COLOR,
  FUN_WEATHER_SNOW_COLOR as WEATHER_SNOW_COLOR,
} from '../constants.js';

// ── Furniture the fun keys on (by type, found at runtime) ──────
export const FUN_TYPE = {
  STRING_LIGHTS: 'STRING_LIGHTS',
  DIYA: 'DIYA',
  HOLI_COLORS: 'HOLI_COLORS',
  NEW_YEAR_BANNER: 'NEW_YEAR_BANNER',
  WHITEBOARD: 'WHITEBOARD',
  WHITEBOARD_DRAWN: 'WHITEBOARD_DRAWN',
  BOOKSHELF_PART: 'BOOKSHELF',
  CROWN: 'CROWN_OVERLAY',
  WALL_CALENDAR: 'WALL_CALENDAR',
  PLANT_STAGE_PREFIX: 'PLANT_STAGE_',
  WINDOW_PREFIX: 'WINDOW_',
  RADIO: 'RADIO',
  FISH_TANK: 'FISH_TANK',
  PRINTER: 'PRINTER',
  PIZZA_BOX: 'PIZZA_BOX',
  PIZZA_BOX_OPEN: 'PIZZA_BOX_OPEN',
  PING_PONG_TABLE: 'PING_PONG_TABLE',
  /** A mug on a table (the limit break's coffee). */
  COFFEE_MUG: 'COFFEE',
} as const;

/** Wall items a garland of lights must not cover (they show the time / news). */
export const FESTIVAL_LIGHTS_SKIP_PARTS = ['CLOCK', 'CALENDAR', 'NOTICE'] as const;
export const FESTIVAL_MAX_DIYAS = 12;
export const FESTIVAL_MAX_HOLI_BOWLS = 6;
/** Seconds between decoration (date) re-checks. */
export const FESTIVAL_RECHECK_SEC = 30;
/** String lights / diya flicker frame time. */
export const FESTIVAL_FLICKER_FRAME_SEC = 0.5;

// ── Rituals ───────────────────────────────────────────────────
export const STANDUP_HOUR = 10;
export const STANDUP_MINUTE = 0;
export const STANDUP_SEATED_SEC = 30;
/** A standup that can't get everyone seated gives up after this long. */
export const STANDUP_MAX_SEC = 120;
export const EVENING_BANNER_HOUR = 19;
export const EVENING_BANNER_MINUTE = 0;
export const EVENING_BANNER_SEC = 60;
/** A ritual still starts this many minutes late (the board opened just after). */
export const RITUAL_GRACE_MIN = 5;
/** The 19:00 dim pulse: how long, and how dark at its deepest. */
export const DIM_PULSE_SEC = 3;
export const DIM_PULSE_MAX_ALPHA = 0.28;
export const BANNER_FADE_SEC = 1;

// ── Whiteboard / library ──────────────────────────────────────
export const PLAN_ENTER_TOOL = 'EnterPlanMode';
export const PLAN_EXIT_TOOL = 'ExitPlanMode';
export const WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch'];
/** Keep reading this long after the last web tool ends (no pacing on short searches). */
export const LIBRARY_LINGER_SEC = 8;

// ── Crown (CROWN_OVERLAY is 16x16, its art's bottom-centre at (8, 8)) ──
export const CROWN_ANCHOR_X = 8;
export const CROWN_ANCHOR_Y = 8;
/** Where the hair starts in a 16x32 character frame when a frame has no pixels to measure. */
export const CROWN_HEAD_TOP_Y = 2;
/** The crown sits this many px down into the hair (worn, not floating). */
export const CROWN_SINK_PX = 1;
export const CHARACTER_FRAME_W = 16;
export const CHARACTER_FRAME_H = 32;

// ── Week wall (WALL_CALENDAR, 32x32) ──────────────────────────
export const CALENDAR_HEADER = { x0: 3, x1: 29, y0: 7, y1: 12 } as const;
export const CALENDAR_CELL = { x0: 3, y0: 14, dx: 4, dy: 3, w: 3, h: 2, cols: 7, rows: 5 } as const;

// ── Growing plants ────────────────────────────────────────────
/** This week's PRs (Monday on) at which a plant reaches stage 2 / stage 3. */
export const PLANT_STAGE_2_PRS = 3;
export const PLANT_STAGE_3_PRS = 7;

// ── Weather in the windows (WINDOW_*, 32x32): the four panes ──
export const WINDOW_PANES: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = [
  { x: 6, y: 10, w: 9, h: 6 },
  { x: 17, y: 10, w: 9, h: 6 },
  { x: 6, y: 18, w: 9, h: 6 },
  { x: 17, y: 18, w: 9, h: 6 },
];

// ── Lo-fi radio ───────────────────────────────────────────────
export const RADIO_STORAGE_KEY = 'pixelAgents.radioOn';
export const RADIO_NOTE_INTERVAL_SEC = 0.9;
export const RADIO_NOTE_LIFETIME_SEC = 2.6;
export const RADIO_NOTE_RISE_PX_PER_SEC = 7;
export const LOFI_BPM = 72;
export const LOFI_VOLUME = 0.16;

// ── Smart pets ────────────────────────────────────────────────
export const GITCAT_NAME = 'gitcat';
export const CLAUDIO_NAME = 'claudio';
/** "Busiest": most tool starts in this window. */
export const BUSY_WINDOW_MS = 10 * 60 * 1000;
/** At most one terrace follow per this long. */
export const GITCAT_FOLLOW_COOLDOWN_SEC = 60 * 60;
export const GITCAT_FOLLOW_CHANCE = 0.35;
export const GITCAT_FOLLOW_MAX_SEC = 60;
export const CLAUDIO_GREET_SEC = 8;
export const CLAUDIO_CELEBRATE_SEC = 10;
/** A ship is pinned on the agent whose shell ran a push / PR command this recently. */
export const SHIP_ATTRIBUTION_MS = 3 * 60 * 1000;
export const PET_HOP_HEIGHT_PX = 4;
export const PET_HOP_PERIOD_SEC = 0.45;
/** Sitting on a desk / sofa: feet this far above the tile's bottom edge. */
export const PET_PERCH_LIFT_PX = 4;
/** How often (seconds) the pets re-think their goals. */
export const PET_THINK_SEC = 1;

// ── Fish tank / printer ───────────────────────────────────────
export const FISH_FRAME_SLOW_SEC = 0.7;
export const FISH_FRAME_FAST_SEC = 0.15;
export const FISH_FRAME_STEP_SEC = 0.12;
export const PRINT_SEC = 3;
export const PRINTER_FRAME_SEC = 0.25;
export const PRINTED_EXTENSIONS: readonly string[] = ['md', 'pdf', 'docx', 'txt'];
export const WRITE_TOOL_NAME = 'Write';

// ── Pizza party ───────────────────────────────────────────────
export const PIZZA_PRS = 3;
export const PIZZA_MAX_TABLES = 2;
export const PIZZA_VISIT_SEC = 10;
export const PIZZA_VISIT_COOLDOWN_SEC = 60 * 60;
export const PIZZA_VISIT_CHANCE = 0.15;

// ── Ping-pong ─────────────────────────────────────────────────
export const PING_PONG_COOLDOWN_SEC = 30 * 60;
export const PING_PONG_CHANCE = 0.35;
export const PING_PONG_MIN_SEC = 30;
export const PING_PONG_MAX_SEC = 60;
/** A waiting smoker counts as idle once it has smoked this long (it stubs out and goes). */
export const PING_PONG_AFTER_SMOKE_SEC = 90;
export const PING_PONG_HIT_SEC = 0.7;

/** How often (seconds) idle pastimes (pizza, ping-pong, standup) are considered. */
export const PASTIME_CHECK_SEC = 15;

// ── Limit break (limitBreak.ts) ───────────────────────────────
/** Seconds an activity lasts once the agent has got there (a range). */
export const BREAK_ACTIVITY_MIN_SEC = 60;
export const BREAK_ACTIVITY_MAX_SEC = 120;
/** Someone on the break says something every this many seconds (a range). */
export const BREAK_CHAT_MIN_SEC = 6;
export const BREAK_CHAT_MAX_SEC = 12;
/** A line stays up this long. */
export const BREAK_LINE_SEC = 4.5;
/** Agents on the break with no free seat stand within this many tiles of the group. */
export const BREAK_STAND_RADIUS_TILES = 3;

/** `{time}` is the reset ("6:30 pm"), or "the reset" when it isn't known. */
export const BREAK_AGENT_LINES: readonly string[] = [
  'so... back at {time}?',
  'I was two tests away.',
  'anyone else get cut off mid-edit?',
  'my context is going to miss me.',
  'I left a TODO. a big one.',
  'pizza counts as a break, right?',
  "I'll pick it up right where I stopped.",
  'is the meter still red?',
  'guess we wait for {time}.',
  'the diff looks fine. probably.',
];
export const BREAK_MANAGER_LINES: readonly string[] = [
  "I'll put the cutoff in tonight's report.",
  'nobody start anything big until {time}.',
  'good time to plan the next steps.',
  'this is why we batch the work.',
];
export const BREAK_ANSH_LINES: readonly string[] = [
  "we're back at {time}, nobody panic.",
  'I should have paced that better.',
  'break time, everyone.',
  'the limit got all of us at once.',
];
