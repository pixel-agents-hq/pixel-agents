import {
  PET_FOLLOW_CHANCE,
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_FOLLOW_DURATION_MIN_SEC,
  PET_FOLLOW_RADIUS_TILES,
  PET_FOLLOW_RECALC_INTERVAL_SEC,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_IDLE_SEQUENCE,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WALK_SEQUENCE,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { findPath, isWalkable } from '../layout/tileMap.js';
import type { PetSpriteFrames } from '../sprites/petSpriteData.js';
import type { Character, Pet, SpriteData, TileType as TileTypeVal } from '../types.js';
import { Direction, PetState, TILE_SIZE } from '../types.js';

/** Inclusive-min / exclusive-max random float */
function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
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

/** Manhattan distance between two tile coords */
function manhattanDistance(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

/**
 * Pick the closest non-sub-agent character within PET_FOLLOW_RADIUS_TILES
 * by Manhattan distance. Excludes despawning characters (matrixEffect === 'despawn').
 */
function findNearbyCharacter(pet: Pet, characters: Map<number, Character>): Character | null {
  let closest: Character | null = null;
  let closestDist = Number.POSITIVE_INFINITY;
  for (const ch of characters.values()) {
    if (ch.matrixEffect === 'despawn') continue;
    const d = manhattanDistance(pet.tileCol, pet.tileRow, ch.tileCol, ch.tileRow);
    if (d > PET_FOLLOW_RADIUS_TILES) continue;
    if (d < closestDist) {
      closest = ch;
      closestDist = d;
    }
  }
  return closest;
}

/**
 * Find a walkable tile adjacent (4-connected) to a character's current tile.
 * Returns the first hit in N/S/W/E scan order, or null if all neighbours are blocked.
 */
function findAdjacentTile(
  ch: Character,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  const candidates = [
    { col: ch.tileCol, row: ch.tileRow - 1 },
    { col: ch.tileCol, row: ch.tileRow + 1 },
    { col: ch.tileCol - 1, row: ch.tileRow },
    { col: ch.tileCol + 1, row: ch.tileRow },
  ];
  for (const t of candidates) {
    if (isWalkable(t.col, t.row, tileMap, blockedTiles)) return t;
  }
  return null;
}

/** Advance the walk-cycle frame counter (4-step cycle). */
function updateWalkAnimation(pet: Pet, dt: number): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= PET_WALK_FRAME_DURATION_SEC) {
    pet.frameTimer -= PET_WALK_FRAME_DURATION_SEC;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/** Advance the idle-cycle frame counter (4-step cycle, slower than walk). */
function updateIdleAnimation(pet: Pet, dt: number): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= PET_IDLE_FRAME_DURATION_SEC) {
    pet.frameTimer -= PET_IDLE_FRAME_DURATION_SEC;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/**
 * Lerp the pet along its current `path`. When it reaches the next tile,
 * shift the tile off the path and update `tileCol`/`tileRow`. Sets `dir`.
 */
function movePetAlongPath(pet: Pet, dt: number): void {
  if (pet.path.length === 0) return;
  const nextTile = pet.path[0];
  pet.dir = directionBetween(pet.tileCol, pet.tileRow, nextTile.col, nextTile.row);

  pet.moveProgress += (PET_WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

  const fromCenter = tileCenter(pet.tileCol, pet.tileRow);
  const toCenter = tileCenter(nextTile.col, nextTile.row);
  const t = Math.min(pet.moveProgress, 1);
  pet.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
  pet.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

  if (pet.moveProgress >= 1) {
    pet.tileCol = nextTile.col;
    pet.tileRow = nextTile.row;
    pet.x = toCenter.x;
    pet.y = toCenter.y;
    pet.path.shift();
    pet.moveProgress = 0;
  }
}

/** Build a fresh pet at a tile with the IDLE FSM entry point. */
export function createPet(id: string, petType: number, col: number, row: number): Pet {
  const center = tileCenter(col, row);
  return {
    id,
    name: '', // Filled by OfficeState.addPet() via getPetName(petType)
    petType,
    state: PetState.IDLE,
    dir: Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC),
    followTargetId: null,
    followRecalcTimer: 0,
    followDuration: 0,
    followDurationLimit: 0,
    bubbleType: null,
    bubbleTimer: 0,
  };
}

/**
 * Tick the pet's FSM by `dt` seconds. Mutates `pet` in place.
 * `walkableTiles`/`characters`/`tileMap`/`blockedTiles` are read-only inputs.
 */
export function updatePet(
  pet: Pet,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  characters: Map<number, Character>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  switch (pet.state) {
    case PetState.IDLE: {
      updateIdleAnimation(pet, dt);
      pet.wanderTimer -= dt;
      if (pet.wanderTimer > 0) break;

      // Roll for follow first
      if (Math.random() < PET_FOLLOW_CHANCE) {
        const target = findNearbyCharacter(pet, characters);
        if (target) {
          pet.state = PetState.FOLLOW;
          pet.followTargetId = target.id;
          pet.followDuration = 0;
          pet.followRecalcTimer = 0;
          pet.followDurationLimit = randomRange(
            PET_FOLLOW_DURATION_MIN_SEC,
            PET_FOLLOW_DURATION_MAX_SEC,
          );
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
      }

      // Else pick a random walkable tile (not own) and try to walk there
      if (walkableTiles.length > 0) {
        // Filter out own tile to avoid zero-length paths
        const candidates = walkableTiles.filter(
          (t) => t.col !== pet.tileCol || t.row !== pet.tileRow,
        );
        if (candidates.length > 0) {
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          const path = findPath(
            pet.tileCol,
            pet.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            pet.state = PetState.WALK;
            pet.path = path;
            pet.moveProgress = 0;
            pet.frame = 0;
            pet.frameTimer = 0;
          }
        }
      }
      pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
      break;
    }

    case PetState.WALK: {
      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);

      if (pet.path.length === 0 && pet.moveProgress === 0) {
        // Arrived
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.FOLLOW: {
      pet.followDuration += dt;
      const target = pet.followTargetId !== null ? characters.get(pet.followTargetId) : undefined;

      // Exit: target gone
      if (!target) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Exit: duration limit
      if (pet.followDuration >= pet.followDurationLimit) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Exit: reached target (Manhattan distance ≤ 1)
      const dist = manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
      if (dist <= 1) {
        // Face the target before settling
        if (dist === 1) {
          pet.dir = directionBetween(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
        }
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Continue following: recompute path periodically
      pet.followRecalcTimer -= dt;
      if (pet.followRecalcTimer <= 0) {
        const adj = findAdjacentTile(target, tileMap, blockedTiles);
        if (adj) {
          const path = findPath(pet.tileCol, pet.tileRow, adj.col, adj.row, tileMap, blockedTiles);
          if (path.length > 0) {
            pet.path = path;
            pet.moveProgress = 0;
          }
        }
        pet.followRecalcTimer = PET_FOLLOW_RECALC_INTERVAL_SEC;
      }

      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);
      break;
    }
  }
}

/**
 * Resolve the sprite for the pet's current state + direction + frame.
 * Returns null when sprites haven't loaded yet — renderer guards.
 */
export function getPetSpriteData(pet: Pet, petSprites: PetSpriteFrames | null): SpriteData | null {
  if (!petSprites) return null;

  if (pet.state === PetState.IDLE) {
    const frameIdx = PET_IDLE_SEQUENCE[pet.frame % PET_IDLE_SEQUENCE.length];
    switch (pet.dir) {
      case Direction.DOWN:
        return petSprites.idleDown[frameIdx];
      case Direction.UP:
        return petSprites.idleUp[frameIdx];
      case Direction.RIGHT:
        return petSprites.idleRight[frameIdx];
      case Direction.LEFT:
        return petSprites.idleLeft[frameIdx];
    }
  }

  // WALK or FOLLOW
  const frameIdx = PET_WALK_SEQUENCE[pet.frame % PET_WALK_SEQUENCE.length];
  switch (pet.dir) {
    case Direction.DOWN:
      return petSprites.walkDown[frameIdx];
    case Direction.UP:
      return petSprites.walkUp[frameIdx];
    case Direction.RIGHT:
      return petSprites.walkRight[frameIdx];
    case Direction.LEFT:
      return petSprites.walkLeft[frameIdx];
  }
}
