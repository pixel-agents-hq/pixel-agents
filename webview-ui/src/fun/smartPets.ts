/**
 * Smart pets (docs/office/DESIGN.md, phase F). The built-in pets keep their
 * own wander-and-follow FSM (petEntity.ts) until they have somewhere to be:
 *
 *  - Gitcat sits on the busiest agent's desk, naps on a Lounge seat beside a
 *    sleeper when nobody is busy, and now and then (at most hourly) follows a
 *    smoker out to the terrace.
 *  - Claudio meets new arrivals just inside the Entrance door, and bounces
 *    around an agent that just pushed or opened a PR.
 *
 * Goals come from funRules (pure); this module walks the pet there and
 * "perches" it on furniture (a desk, a sofa) by drawing it on the tile.
 */

import {
  movePetAlongPath,
  updateIdleAnimation,
  updateWalkAnimation,
} from '../office/engine/petEntity.js';
import { findPath, isWalkable } from '../office/layout/tileMap.js';
import type { Character, Pet, Seat, TileType as TileTypeVal } from '../office/types.js';
import { Direction, PetState, TILE_SIZE } from '../office/types.js';
import {
  CLAUDIO_NAME,
  GITCAT_NAME,
  PET_HOP_HEIGHT_PX,
  PET_HOP_PERIOD_SEC,
  PET_PERCH_LIFT_PX,
  PET_THINK_SEC,
} from './funConstants.js';
import type { ClaudioGoal, GitcatGoal } from './funRules.js';

/** What the pets read from the office. */
export interface PetWorld {
  characters: ReadonlyMap<number, Character>;
  seats: ReadonlyMap<string, Seat>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  /** Footprint of the desk covering a tile, if any. */
  deskAt: (col: number, row: number) => { col: number; row: number; w: number; h: number } | null;
  /** The zone label of a tile, or null. */
  zoneAt: (col: number, row: number) => string | null;
  door: { col: number; row: number; inward: Direction } | null;
}

/** Where a driven pet is headed: a tile to walk to, and maybe a perch to hop onto. */
interface PetPlan {
  key: string;
  approach: { col: number; row: number };
  /** Drawn here (pixel feet) once at the approach tile; null: stand on the approach tile. */
  perch: { x: number; y: number; dir: Direction } | null;
  /** Bounce on the spot (celebrating). */
  hop: boolean;
  /** Face this way when there (no perch). */
  face?: Direction;
}

const DIR_STEP: Record<Direction, { dc: number; dr: number }> = {
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

/** Standing inside the door (it opens `inward`), face back out at it. */
const FACING_DOOR: Record<Direction, Direction> = {
  [Direction.DOWN]: Direction.UP,
  [Direction.UP]: Direction.DOWN,
  [Direction.LEFT]: Direction.RIGHT,
  [Direction.RIGHT]: Direction.LEFT,
};

const NEIGHBOURS = [
  { dc: 0, dr: 1 },
  { dc: -1, dr: 0 },
  { dc: 1, dr: 0 },
  { dc: 0, dr: -1 },
];

const tileCenter = (col: number, row: number) => ({
  x: col * TILE_SIZE + TILE_SIZE / 2,
  y: row * TILE_SIZE + TILE_SIZE / 2,
});

export function petRole(pet: Pet): 'gitcat' | 'claudio' | null {
  const name = pet.name.trim().toLowerCase();
  if (name === GITCAT_NAME) return 'gitcat';
  if (name === CLAUDIO_NAME) return 'claudio';
  return null;
}

/** Per-pet driving state. */
interface Driven {
  plan: PetPlan | null;
  thinkIn: number;
  /** Unreachable plan keys, skipped for a while (key → seconds left). */
  blocked: Map<string, number>;
  /** Perched on furniture (drawn off the walkable grid). */
  perched: boolean;
  hopClock: number;
  /** Celebrate: index into the agent's neighbour ring. */
  ring: number;
  ringIn: number;
}

export class SmartPets {
  private readonly driven = new Map<string, Driven>();

  /**
   * Drive one pet a frame. Returns false when the pet is free (its own FSM
   * runs); true when it was moved here. `goalOf` gives the pet's current goal.
   */
  drive(
    pet: Pet,
    dt: number,
    world: PetWorld,
    goalOf: (pet: Pet) => GitcatGoal | ClaudioGoal | null,
  ): boolean {
    let d = this.driven.get(pet.id);
    if (!d) {
      d = {
        plan: null,
        thinkIn: 0,
        blocked: new Map(),
        perched: false,
        hopClock: 0,
        ring: 0,
        ringIn: 0,
      };
      this.driven.set(pet.id, d);
    }
    for (const [k, left] of d.blocked) {
      if (left - dt <= 0) d.blocked.delete(k);
      else d.blocked.set(k, left - dt);
    }
    d.thinkIn -= dt;
    if (d.thinkIn <= 0) {
      d.thinkIn = PET_THINK_SEC;
      const goal = goalOf(pet);
      const plan = goal ? this.planFor(pet, goal, world, d) : null;
      if (plan && d.blocked.has(plan.key)) d.plan = null;
      else if (!plan || plan.key !== d.plan?.key || !sameTile(plan.approach, d.plan.approach)) {
        d.plan = plan;
        if (plan) {
          pet.path = [];
          pet.moveProgress = 0;
        }
      } else {
        d.plan.perch = plan.perch; // a perch can move a pixel or two (e.g. the agent's seat)
      }
    }

    const plan = d.plan;
    if (!plan) {
      if (d.perched) this.hopDown(pet, world, d);
      return false;
    }

    // Walk to the approach tile.
    const atApproach =
      pet.tileCol === plan.approach.col &&
      pet.tileRow === plan.approach.row &&
      pet.moveProgress === 0;
    if (!atApproach) {
      if (d.perched) this.hopDown(pet, world, d);
      const end = pet.path[pet.path.length - 1];
      if (!end || !sameTile(end, plan.approach)) {
        const path = findPath(
          pet.tileCol,
          pet.tileRow,
          plan.approach.col,
          plan.approach.row,
          world.tileMap,
          world.blockedTiles,
        );
        if (path.length === 0) {
          d.blocked.set(plan.key, 20);
          d.plan = null;
          return false;
        }
        pet.path = path;
        pet.moveProgress = 0;
      }
      pet.state = PetState.WALK;
      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);
      if (plan.hop) this.applyHop(pet, d, dt);
      return true;
    }

    // There: perch, stand, or bounce.
    pet.path = [];
    pet.state = PetState.IDLE;
    pet.wanderTimer = PET_THINK_SEC * 2; // its own FSM stays put meanwhile
    updateIdleAnimation(pet, dt);
    if (plan.perch) {
      d.perched = true;
      pet.x = plan.perch.x;
      pet.y = plan.perch.y;
      pet.dir = plan.perch.dir;
      return true;
    }
    const c = tileCenter(pet.tileCol, pet.tileRow);
    pet.x = c.x;
    pet.y = c.y;
    if (plan.face !== undefined) pet.dir = plan.face;
    if (plan.hop) {
      this.applyHop(pet, d, dt);
      this.stepRing(pet, plan, world, d, dt);
    }
    return true;
  }

  /** Forget a pet (removed from the office). */
  forget(id: string): void {
    this.driven.delete(id);
  }

  private applyHop(pet: Pet, d: Driven, dt: number): void {
    d.hopClock += dt;
    const phase = (d.hopClock % PET_HOP_PERIOD_SEC) / PET_HOP_PERIOD_SEC;
    pet.y -= Math.sin(phase * Math.PI) * PET_HOP_HEIGHT_PX;
  }

  /** Celebrating: hop to the next free tile around the agent every so often. */
  private stepRing(pet: Pet, plan: PetPlan, world: PetWorld, d: Driven, dt: number): void {
    d.ringIn -= dt;
    if (d.ringIn > 0) return;
    d.ringIn = PET_HOP_PERIOD_SEC * 2;
    const [, idStr] = plan.key.split(':');
    const ch = world.characters.get(Number(idStr));
    if (!ch) return;
    for (let i = 1; i <= NEIGHBOURS.length; i++) {
      const n = NEIGHBOURS[(d.ring + i) % NEIGHBOURS.length];
      const col = ch.tileCol + n.dc;
      const row = ch.tileRow + n.dr;
      if (!isWalkable(col, row, world.tileMap, world.blockedTiles)) continue;
      if (col === pet.tileCol && row === pet.tileRow) continue;
      if (Math.abs(col - pet.tileCol) + Math.abs(row - pet.tileRow) !== 1) continue;
      d.ring = (d.ring + i) % NEIGHBOURS.length;
      pet.path = [{ col, row }];
      pet.moveProgress = 0;
      plan.approach = { col, row };
      return;
    }
  }

  /** Off the furniture: back onto the walkable tile it hopped up from. */
  private hopDown(pet: Pet, world: PetWorld, d: Driven): void {
    d.perched = false;
    if (!isWalkable(pet.tileCol, pet.tileRow, world.tileMap, world.blockedTiles)) {
      const free = nearestWalkable(pet.tileCol, pet.tileRow, world);
      if (free) {
        pet.tileCol = free.col;
        pet.tileRow = free.row;
      }
    }
    const c = tileCenter(pet.tileCol, pet.tileRow);
    pet.x = c.x;
    pet.y = c.y;
    pet.path = [];
    pet.moveProgress = 0;
    pet.state = PetState.IDLE;
    pet.frame = 0;
    pet.frameTimer = 0;
  }

  private planFor(
    pet: Pet,
    goal: GitcatGoal | ClaudioGoal,
    world: PetWorld,
    d: Driven,
  ): PetPlan | null {
    switch (goal.kind) {
      case 'roam':
        return null;
      case 'desk':
        return deskPlan(pet, world.characters.get(goal.agentId), world);
      case 'nap':
        return napPlan(pet, world.characters.get(goal.agentId), world);
      case 'terrace': {
        const ch = world.characters.get(goal.agentId);
        if (!ch) return null;
        const spot = ch.zoneTarget ?? { col: ch.tileCol, row: ch.tileRow };
        const approach = walkableNear(spot.col, spot.row, pet, world, true);
        return approach ? { key: `terrace:${ch.id}`, approach, perch: null, hop: false } : null;
      }
      case 'greet': {
        const door = world.door;
        if (!door) return null;
        const step = DIR_STEP[door.inward];
        // Two tiles in from the door, else one, else beside it.
        for (const k of [2, 1]) {
          const col = door.col + step.dc * k;
          const row = door.row + step.dr * k;
          if (isWalkable(col, row, world.tileMap, world.blockedTiles)) {
            return {
              key: `greet:${goal.agentId}`,
              approach: { col, row },
              perch: null,
              hop: false,
              face: FACING_DOOR[door.inward],
            };
          }
        }
        return null;
      }
      case 'celebrate': {
        const ch = world.characters.get(goal.agentId);
        if (!ch) return null;
        // Keep the current ring tile while it's still next to the agent.
        const current = d.plan?.key === `celebrate:${ch.id}` ? d.plan.approach : null;
        const near =
          current && Math.abs(current.col - ch.tileCol) + Math.abs(current.row - ch.tileRow) === 1
            ? current
            : walkableNear(ch.tileCol, ch.tileRow, pet, world, true);
        return near ? { key: `celebrate:${ch.id}`, approach: near, perch: null, hop: true } : null;
      }
    }
  }
}

function sameTile(a: { col: number; row: number }, b: { col: number; row: number }): boolean {
  return a.col === b.col && a.row === b.row;
}

/** The walkable tile next to (col,row) nearest the pet (or (col,row) itself when allowed). */
function walkableNear(
  col: number,
  row: number,
  pet: Pet,
  world: PetWorld,
  excludeCentre: boolean,
): { col: number; row: number } | null {
  const options: Array<{ col: number; row: number }> = [];
  if (!excludeCentre) options.push({ col, row });
  for (const n of NEIGHBOURS) options.push({ col: col + n.dc, row: row + n.dr });
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (const t of options) {
    if (!isWalkable(t.col, t.row, world.tileMap, world.blockedTiles)) continue;
    const dist = Math.abs(t.col - pet.tileCol) + Math.abs(t.row - pet.tileRow);
    if (dist < bestD) {
      best = t;
      bestD = dist;
    }
  }
  return best;
}

function nearestWalkable(
  col: number,
  row: number,
  world: PetWorld,
): { col: number; row: number } | null {
  for (let r = 1; r <= 3; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.abs(dc) + Math.abs(dr) !== r) continue;
        if (isWalkable(col + dc, row + dr, world.tileMap, world.blockedTiles)) {
          return { col: col + dc, row: row + dr };
        }
      }
    }
  }
  return null;
}

/**
 * The busiest agent's desk: the desk tile in front of its seat, one column to
 * the side when the desk is wide enough (so the cat isn't hidden behind the
 * agent's head), drawn at the desk's front edge.
 */
function deskPlan(pet: Pet, ch: Character | undefined, world: PetWorld): PetPlan | null {
  if (!ch?.seatId) return null;
  const seat = world.seats.get(ch.seatId);
  if (!seat) return null;
  const step = DIR_STEP[seat.facingDir];
  for (let depth = 1; depth <= 2; depth++) {
    const col = seat.seatCol + step.dc * depth;
    const row = seat.seatRow + step.dr * depth;
    const desk = world.deskAt(col, row);
    if (!desk) continue;
    // A column (or row) beside the agent's line of sight, still on the desk.
    const sideways =
      step.dc === 0
        ? [1, -1].map((s) => ({ col: col + s, row }))
        : [1, -1].map((s) => ({ col, row: row + s }));
    const onDesk = (t: { col: number; row: number }) =>
      t.col >= desk.col &&
      t.col < desk.col + desk.w &&
      t.row >= desk.row &&
      t.row < desk.row + desk.h;
    const perchTile = sideways.find(onDesk) ?? { col, row };
    const approach =
      walkableNear(perchTile.col, perchTile.row, pet, world, true) ??
      walkableNear(seat.seatCol, seat.seatRow, pet, world, true);
    if (!approach) return null;
    const deskBottom = (desk.row + desk.h) * TILE_SIZE;
    return {
      key: `desk:${ch.id}:${perchTile.col},${perchTile.row}`,
      approach,
      perch: {
        x: perchTile.col * TILE_SIZE + TILE_SIZE / 2,
        y: deskBottom - PET_PERCH_LIFT_PX,
        dir: Direction.DOWN,
      },
      hop: false,
    };
  }
  return null;
}

/** A nap beside a sleeper: a free seat within two tiles of it (a sofa), else the floor next to it. */
function napPlan(pet: Pet, ch: Character | undefined, world: PetWorld): PetPlan | null {
  if (!ch) return null;
  const at = { col: ch.tileCol, row: ch.tileRow };
  const zone = world.zoneAt(at.col, at.row);
  let best: Seat | null = null;
  let bestD = Infinity;
  for (const seat of world.seats.values()) {
    if (seat.assigned) continue;
    const dist = Math.abs(seat.seatCol - at.col) + Math.abs(seat.seatRow - at.row);
    if (dist === 0 || dist > 2) continue;
    if (zone && world.zoneAt(seat.seatCol, seat.seatRow) !== zone) continue;
    if (dist < bestD) {
      best = seat;
      bestD = dist;
    }
  }
  if (best) {
    const approach = walkableNear(best.seatCol, best.seatRow, pet, world, true);
    if (approach) {
      return {
        key: `nap:${ch.id}:${best.uid}`,
        approach,
        perch: {
          x: best.seatCol * TILE_SIZE + TILE_SIZE / 2,
          y: (best.seatRow + 1) * TILE_SIZE - PET_PERCH_LIFT_PX,
          dir: best.facingDir,
        },
        hop: false,
      };
    }
  }
  const floor = walkableNear(at.col, at.row, pet, world, true);
  return floor ? { key: `nap:${ch.id}`, approach: floor, perch: null, hop: false } : null;
}
