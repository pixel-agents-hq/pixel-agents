export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
} from '../constants.js';

// The layout model lives in core (the server reads and edits layouts too).
export type {
  AreaDefinition,
  CarpetTile,
  ColorValue,
  OfficeLayout,
  PlacedFurniture,
  PlacedPet,
  Seat,
} from '../../../core/src/layout/types.js';
export { Direction, TileType } from '../../../core/src/layout/types.js';
import type { Direction } from '../../../core/src/layout/types.js';
import type { AgentWorktree } from '../../../core/src/messages.js';

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent. [row][col] */
export type SpriteData = string[][];

export interface FurnitureInstance {
  sprite: SpriteData;
  /** Pixel x (top-left) */
  x: number;
  /** Pixel y (top-left) */
  y: number;
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number;
  /** Render-time horizontal flip flag (for mirrored side variants) */
  mirrored?: boolean;
  /** The placed item it draws (absent for walls). */
  uid?: string;
}

export interface ToolActivity {
  toolId: string;
  status: string;
  done: boolean;
  permissionWait?: boolean;
}

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
  PETS: 'pets',
  CARPET_PAINT: 'carpet_paint',
  CARPET_PICK: 'carpet_pick',
  AREA_PAINT: 'area_paint',
  /** Colour-only eyedropper: takes a placed item's colour, leaves its type alone. */
  COLOR_PICK: 'color_pick',
  /** Wall eyedropper: takes a wall's set and colour, then paints walls with them. */
  WALL_PICK: 'wall_pick',
  /** Floor panel's Select: picks touching floor tiles of one pattern and colour, restyled together. */
  FLOOR_SECTION: 'floor_section',
  /** Walls panel's Select: picks touching walls of one set and colour, restyled together. */
  WALL_SECTION: 'wall_section',
} as const;
export type EditTool = (typeof EditTool)[keyof typeof EditTool];

export interface FurnitureCatalogEntry {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
  /** Whether this is a side-oriented asset that produces a mirrored "left" variant */
  mirrorSide?: boolean;
}

/** A blink clock (office/engine/blink.ts drives it). */
export interface Blinker {
  /** Seconds until the eyes next shut. */
  blinkIn: number;
  /** Seconds the eyes stay shut (0 = open). */
  blinkShut: number;
}

/** One stop of a Visit: the tile, the way to face there, and how long to stand
 *  there before moving on (VISIT_LINGER_MS when not given). */
export interface VisitStop {
  col: number;
  row: number;
  dir: Direction;
  lingerSec?: number;
  /** A Message show's stop: stand beside this agent's character — `col`/`row`/`dir`
   *  are re-aimed (visitsController) while walking, as the recipient moves — at `at`. */
  beside?: { agentId: number; at?: { col: number; row: number } };
  /** What the character says while it stands there (a Message's gist). */
  say?: string;
  /** Working there (a Buildout's builder): typing, standing, while arrived. */
  work?: boolean;
}

/** What a character does once its visit's last stop is over: wander as usual,
 *  hold there (until the visit is ended), or go back to its seat. */
export type VisitEnd = 'wander' | 'stay' | 'seat';

/** A Visit under way (CONTEXT.md): the stops still ahead (the first is the
 *  current one) and what happens after the last. */
export interface CharacterVisit {
  stops: VisitStop[];
  then: VisitEnd;
  /** Standing at the current stop, facing its way. */
  arrived: boolean;
  /** Seconds left at the current stop once arrived. */
  lingerLeft: number;
}

/**
 * Something a character is off doing instead of its agent's work: the
 * server's Visit, or a local errand of this office's own (a Message show, a
 * Buildout's work) pushed above it. A character keeps them as a stack — the
 * top one moves it; finishing it uncovers the one below
 * (engine/visitsController.ts implements them).
 */
export interface Errand {
  /** The stops it walks. */
  readonly visit: CharacterVisit;
  /** One frame: null while under way, else what the character does when
   *  nothing is left underneath (wander, or back to its seat). */
  step(ch: Character, dt: number): Exclude<VisitEnd, 'stay'> | null;
  /** The server's Visit ended: whether this errand ends with it. */
  endsWithServerVisit(): boolean;
}

export interface Character extends Blinker {
  id: number;
  state: CharacterState;
  dir: Direction;
  /** Pixel position */
  x: number;
  y: number;
  /** Current tile column */
  tileCol: number;
  /** Current tile row */
  tileRow: number;
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>;
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number;
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null;
  /** Palette index (0-5) */
  palette: number;
  /** Which copy of its character this is (0 = the first, n = its nth repeat,
   *  drawn in the nth repeat clothes colour; core/src/characters/repeatClothes.ts) */
  repeat: number;
  /** Animation frame index */
  frame: number;
  /** Time accumulator for animation */
  frameTimer: number;
  /** Timer for idle wander decisions */
  wanderTimer: number;
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number;
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number;
  /** Whether the agent is actively working */
  isActive: boolean;
  /** Assigned seat uid, or null if no seat */
  seatId: string | null;
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null;
  /** Only meaningful while bubbleType === 'waiting': true when the agent went
   *  idle waiting on the user (surfaces the "Waiting for input" label);
   *  false/undefined when the agent simply finished its turn (checkmark only,
   *  label falls through to idle). */
  waitingAwaitingInput?: boolean;
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number;
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean;
  /** A helper's time since its last tool call ended (0 while working). */
  helperIdleSec: number;
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null;
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null;
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number;
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[];
  /** Directory name — the agent's origin label (only set for multi-root workspaces) */
  directoryName?: string;
  /** The Worktree the agent runs in (its label and card show the branch);
   *  teammates show their lead's. */
  worktree?: AgentWorktree;
  /** The Nickname it was launched with: shown after its Directory on its label
   *  and card. Only a label (a Teammate's name is `agentName`). */
  nickname?: string;
  /** Headless agent: adopted from outside the office, so there is no terminal to
   *  focus. Rendered translucent. Teammates and sub-agents are never headless —
   *  clicking them reaches their lead's / parent's terminal. */
  isHeadless?: boolean;
  /** The first-run consent greeter. A MARKER, not a gate: the greeter lives in
   *  OfficeState.greeter, outside the agent map, so seat assignment, palette
   *  diversity, the FSM, hit-testing and seat persistence never see it — no
   *  per-consumer guard reads this flag. It exists for the render/e2e snapshot
   *  (testHooks.getCharacters) to tell the greeter from agents. */
  isGreeter?: boolean;

  // -- Agent Teams --
  /** Team name this agent belongs to */
  teamName?: string;
  /** Role name within the team (null for lead) */
  agentName?: string;
  /** Whether this agent is the team lead */
  isTeamLead?: boolean;
  /** ID of the lead agent (set on teammates) */
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;

  // -- Context gauge --
  /** Tokens in the agent's context as of its newest turn; 0 until reported.
   *  Sub-agents have no session of their own and stay at 0. */
  contextTokens: number;
  /** Window `contextTokens` is measured against. */
  maxContextTokens: number;
  /** True once the server reported the context: from then on 0 is a real
   *  reading (a cleared session, a full gauge), not "no turn yet". */
  contextReported?: boolean;

  /** Its errands, the top one current (a server Visit at the bottom, a
   *  Message show or Buildout work above): while any, the top one — not its
   *  agent's work or the wander AI — moves it (engine/visitsController.ts). */
  errands?: Errand[];
  /** A Message's gist said where it stands (reduced motion, or no one to walk
   *  to), and the seconds it still shows. */
  saying?: { gist: string; left: number } | null;
}

export const PetState = { IDLE: 'idle', WALK: 'walk', FOLLOW: 'follow' } as const;
export type PetState = (typeof PetState)[keyof typeof PetState];

/** Runtime pet (mutated by FSM tick). */
export interface Pet {
  /** Stable identifier; matches PlacedPet.id in the layout. */
  id: string;
  /** Display name from sprite manifest (e.g. "Claudio", "Gitcat"). */
  name: string;
  /** Index into the loaded PetSpriteFrames[] array. */
  petType: number;
  state: PetState;
  dir: Direction;
  /** Pixel position (bottom-center anchor). */
  x: number;
  y: number;
  /** Current tile column / row (integer). */
  tileCol: number;
  tileRow: number;
  /** Remaining path steps (tile coords). */
  path: Array<{ col: number; row: number }>;
  /** 0..1 lerp progress between current tile and next tile. */
  moveProgress: number;
  /** Animation cycle index 0..3. */
  frame: number;
  frameTimer: number;
  /** Countdown for next IDLE→WALK/FOLLOW decision. */
  wanderTimer: number;
  /** ID of the character being followed, or null. */
  followTargetId: number | null;
  /** Countdown until next path re-computation while following. */
  followRecalcTimer: number;
  /** Time spent in current FOLLOW episode. */
  followDuration: number;
  /** Random [5, 15] limit; FOLLOW exits when followDuration >= this. */
  followDurationLimit: number;
  /** Pet's heart-bubble overlay (set on click), or null. */
  bubbleType: 'heart' | null;
  /** Countdown timer for the heart bubble (mirrors character waiting bubble). */
  bubbleTimer: number;
}
