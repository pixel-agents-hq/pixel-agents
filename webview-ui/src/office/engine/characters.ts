import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  HELPER_FOLLOW_RADIUS_TILES,
  HELPER_STAND_UP_DELAY_SEC,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { findPath } from '../layout/tileMap.js';
import type { CharacterSprites } from '../sprites/spriteData.js';
import { isReadingToolName } from '../toolUtils.js';
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';
import { startBlink } from './blink.js';

/** Whether a tool should show the reading animation (vs typing). Taxonomy comes
 *  from the active HookProvider via the `providerCapabilities` message. */
export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return isReadingToolName(tool);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  repeat = 0,
): Character {
  const col = seat ? seat.seatCol : 1;
  const row = seat ? seat.seatRow : 1;
  const center = tileCenter(col, row);
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    repeat,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    helperIdleSec: 0,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    ...startBlink(),
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt;

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 2;
      }
      // If no longer active, stand up and start wandering (after seatTimer expires)
      if (!ch.isActive) {
        if (ch.seatTimer > 0) {
          ch.seatTimer -= dt;
          break;
        }
        ch.seatTimer = 0; // clear sentinel
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        ch.wanderCount = 0;
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
      }
      break;
    }

    case CharacterState.IDLE: {
      // No idle animation — static pose
      ch.frame = 0;
      if (ch.seatTimer < 0) ch.seatTimer = 0; // clear turn-end sentinel
      // If became active, pathfind to seat
      if (ch.isActive) {
        if (!ch.seatId) {
          // No seat assigned — type in place
          ch.state = CharacterState.TYPE;
          ch.frame = 0;
          ch.frameTimer = 0;
          break;
        }
        const seat = seats.get(ch.seatId);
        if (seat) {
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            seat.seatCol,
            seat.seatRow,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
          } else {
            // Already at seat or no path — sit down
            ch.state = CharacterState.TYPE;
            ch.dir = seat.facingDir;
            ch.frame = 0;
            ch.frameTimer = 0;
          }
        }
        break;
      }
      // Countdown wander timer
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat for a rest
        if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          const seat = seats.get(ch.seatId);
          if (seat) {
            const path = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
            );
            if (path.length > 0) {
              ch.path = path;
              ch.moveProgress = 0;
              ch.state = CharacterState.WALK;
              ch.frame = 0;
              ch.frameTimer = 0;
              break;
            }
          }
        }
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
            ch.wanderCount++;
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
      }
      break;
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 4;
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow);
        ch.x = center.x;
        ch.y = center.y;

        if (ch.isActive) {
          if (!ch.seatId) {
            // No seat — type in place
            ch.state = CharacterState.TYPE;
          } else {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
            } else {
              ch.state = CharacterState.IDLE;
            }
          }
        } else {
          // Check if arrived at assigned seat — sit down for a rest before wandering again
          if (ch.seatId) {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
              // seatTimer < 0 is a sentinel from setAgentActive(false) meaning
              // "turn just ended" — skip the long rest so idle transition is immediate
              if (ch.seatTimer < 0) {
                ch.seatTimer = 0;
              } else {
                restInChair(ch);
              }
              ch.wanderCount = 0;
              ch.wanderLimit = randomInt(
                WANDER_MOVES_BEFORE_REST_MIN,
                WANDER_MOVES_BEFORE_REST_MAX,
              );
              ch.frame = 0;
              ch.frameTimer = 0;
              break;
            }
          }
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        }
        ch.frame = 0;
        ch.frameTimer = 0;
        break;
      }

      stepAlongPath(ch, dt);

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId);
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1];
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
            );
            if (newPath.length > 0) {
              ch.path = newPath;
              ch.moveProgress = 0;
            }
          }
        }
      }
      break;
    }
  }
}

/** Move along `ch.path` for one frame; on reaching a tile, make it the character's tile. */
function stepAlongPath(ch: Character, dt: number): void {
  const nextTile = ch.path[0];
  ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row);

  ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

  const fromCenter = tileCenter(ch.tileCol, ch.tileRow);
  const toCenter = tileCenter(nextTile.col, nextTile.row);
  const t = Math.min(ch.moveProgress, 1);
  ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
  ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

  if (ch.moveProgress >= 1) {
    ch.tileCol = nextTile.col;
    ch.tileRow = nextTile.row;
    ch.x = toCenter.x;
    ch.y = toCenter.y;
    ch.path.shift();
    ch.moveProgress = 0;
  }
}

type Tile = { col: number; row: number };

/** Tiles between two tiles, counting diagonals as one step. */
function tileDistance(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** Within range of home (the lead's seat), and not on home itself. */
function atHome(at: Tile, home: Tile): boolean {
  const d = tileDistance(at, home);
  return d > 0 && d <= HELPER_FOLLOW_RADIUS_TILES;
}

/**
 * A helper (sub-agent) for one frame. It has no chair and never wanders: it
 * stays around `home` — its lead's seat, or the lead itself when the lead has
 * no seat — walks back when home moves, and settles there facing the way its
 * lead does (`facing`): sitting while it works (in the air: there is no chair
 * under it), standing while it waits. `pickSpot` names a free tile near home.
 */
export function updateHelper(
  ch: Character,
  dt: number,
  home: Tile | null,
  facing: Direction | null,
  pickSpot: () => Tile | null,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt;
  ch.helperIdleSec = ch.isActive ? 0 : ch.helperIdleSec + dt;

  if (ch.state === CharacterState.WALK && ch.path.length > 0) {
    if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
      ch.frameTimer -= WALK_FRAME_DURATION_SEC;
      ch.frame = (ch.frame + 1) % 4;
    }
    stepAlongPath(ch, dt);
    const end = ch.path[ch.path.length - 1];
    // Mid-tile, or still headed home: keep walking. Otherwise (the path is
    // done, or home moved away from where it ends) decide again.
    if (ch.moveProgress > 0 || (end && (!home || atHome(end, home)))) return;
    ch.path = [];
  }

  if (home && !atHome({ col: ch.tileCol, row: ch.tileRow }, home)) {
    const spot = pickSpot();
    const path = spot
      ? findPath(ch.tileCol, ch.tileRow, spot.col, spot.row, tileMap, blockedTiles)
      : [];
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      if (ch.state !== CharacterState.WALK) {
        ch.state = CharacterState.WALK;
        ch.frame = 0;
        ch.frameTimer = 0;
      }
      return;
    }
    // No way to get closer: stay where we are.
  }

  if (ch.state === CharacterState.WALK || wantsState(ch) !== ch.state) {
    settle(ch, facing);
    return;
  }
  // Settled: turn with the lead (a reseated lead faces a new way).
  if (facing !== null) ch.dir = facing;
  if (ch.state === CharacterState.TYPE && ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
    ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
    ch.frame = (ch.frame + 1) % 2;
  }
}

/** Sitting while working, standing while waiting. The gap between two tool
 *  calls is not waiting: standing up and sitting back down every few seconds
 *  swaps the seated sprite for the standing one and back, so a helper stands
 *  only once it has been idle for HELPER_STAND_UP_DELAY_SEC. */
function wantsState(ch: Character): CharacterState {
  const working = ch.isActive || ch.helperIdleSec < HELPER_STAND_UP_DELAY_SEC;
  return working ? CharacterState.TYPE : CharacterState.IDLE;
}

/** Stop on the current tile, facing the lead's way, in the pose the helper's work calls for. */
function settle(ch: Character, facing: Direction | null): void {
  const center = tileCenter(ch.tileCol, ch.tileRow);
  ch.x = center.x;
  ch.y = center.y;
  ch.path = [];
  ch.moveProgress = 0;
  if (facing !== null) ch.dir = facing;
  ch.state = wantsState(ch);
  ch.frame = 0;
  ch.frameTimer = 0;
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      // Resting in its chair (a turn over, or back from wandering). Helpers have no
      // chair: they stand once idle, and keep typing through the gaps between tools.
      if (!ch.isActive && !ch.isSubagent) return sprites.seated[ch.dir];
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2];
      }
      return sprites.typing[ch.dir][ch.frame % 2];
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4];
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1];
    default:
      return sprites.walk[ch.dir][1];
  }
}

/** Sit out a usual rest in the chair before standing up to wander. */
export function restInChair(ch: Character): void {
  ch.seatTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC);
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
