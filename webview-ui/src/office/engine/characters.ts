import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  HELPER_FOLLOW_RADIUS_TILES,
  HELPER_STAND_UP_DELAY_SEC,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  TYPE_FRAME_DURATION_SEC,
  VISIT_LINGER_MS,
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
import type {
  Character,
  CharacterVisit,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
  VisitStop,
} from '../types.js';
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

/** One frame of walking `ch.path`, animated, for a character no FSM drives
 *  (the greeter); false once there is nothing left to walk. */
export function walkAlong(ch: Character, dt: number): boolean {
  if (ch.path.length === 0) return false;
  ch.state = CharacterState.WALK;
  ch.frameTimer += dt;
  if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
    ch.frameTimer -= WALK_FRAME_DURATION_SEC;
    ch.frame = (ch.frame + 1) % 4;
  }
  stepAlongPath(ch, dt);
  return true;
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

/** How a visit went this frame: still under way (walking, lingering or
 *  staying), over (the last stop's linger is done), or lost (a stop this
 *  office can't walk to — its layout may differ from the server's). */
export type VisitProgress = 'visiting' | 'over' | 'lost';

/** The visit a character is walking now: its top errand's, or null. */
export function currentVisit(ch: Character): CharacterVisit | null {
  const errands = ch.errands;
  return errands && errands.length > 0 ? errands[errands.length - 1].visit : null;
}

/**
 * A character on `visit` (its current errand's) for one frame: walk to the current stop,
 * face its way and stand there for its linger, then on to the next stop. At
 * the last stop of a visit that stays it holds until the visit is ended. Its
 * agent's work doesn't move it meanwhile — ending the visit hands it back to
 * the usual FSM (updateCharacter), which takes an active agent to its seat.
 */
export function updateVisit(
  ch: Character,
  visit: CharacterVisit,
  dt: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): VisitProgress {
  ch.frameTimer += dt;
  for (;;) {
    const stop = visit.stops[0];
    if (!stop) return 'over';
    if (visit.arrived) {
      if (stop.work && ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 2;
      }
      if (visit.then === 'stay' && visit.stops.length === 1) return 'visiting';
      visit.lingerLeft -= dt;
      if (visit.lingerLeft > 0) return 'visiting';
      visit.stops.shift();
      visit.arrived = false;
      dt = 0; // the next stop's walk starts next frame
      if (visit.stops.length === 0) return 'over';
      // A stop beside someone (a Message show's) is aimed before it is walked:
      // until then it holds a placeholder tile, maybe the one underfoot.
      if (visit.stops[0].beside) return 'visiting';
      continue;
    }

    const end = ch.path[ch.path.length - 1];
    if (!end || end.col !== stop.col || end.row !== stop.row) {
      if (ch.moveProgress === 0 && ch.tileCol === stop.col && ch.tileRow === stop.row) {
        arriveAt(ch, visit, stop);
        continue;
      }
      // Mid-step, finish the step under way and set off from there.
      const next = ch.moveProgress > 0 ? ch.path[0] : undefined;
      const from = next ?? { col: ch.tileCol, row: ch.tileRow };
      const rest = findPath(from.col, from.row, stop.col, stop.row, tileMap, blockedTiles);
      const reached = rest.length > 0 || (from.col === stop.col && from.row === stop.row);
      if (!reached) return 'lost';
      ch.path = next ? [next, ...rest] : rest;
      if (ch.state !== CharacterState.WALK) {
        ch.state = CharacterState.WALK;
        ch.frame = 0;
        ch.frameTimer = 0;
      }
    }

    if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
      ch.frameTimer -= WALK_FRAME_DURATION_SEC;
      ch.frame = (ch.frame + 1) % 4;
    }
    stepAlongPath(ch, dt);
    if (ch.path.length === 0) arriveAt(ch, visit, stop);
    return 'visiting';
  }
}

/** Stand at a visit's stop, facing its way, for its linger. */
function arriveAt(ch: Character, visit: CharacterVisit, stop: VisitStop): void {
  const center = tileCenter(stop.col, stop.row);
  ch.x = center.x;
  ch.y = center.y;
  ch.path = [];
  ch.moveProgress = 0;
  ch.dir = stop.dir;
  ch.state = CharacterState.IDLE;
  ch.frame = 0;
  ch.frameTimer = 0;
  visit.arrived = true;
  visit.lingerLeft = stop.lingerSec ?? VISIT_LINGER_MS / 1000;
}

/** Standing at a stop it works at (a Buildout's builder). */
function isAtWork(visit: CharacterVisit | null): boolean {
  return visit !== null && visit.arrived && visit.stops[0]?.work === true;
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
      // A builder at work (a Buildout): typing where it stands.
      if (isAtWork(currentVisit(ch))) return sprites.typing[ch.dir][ch.frame % 2];
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
