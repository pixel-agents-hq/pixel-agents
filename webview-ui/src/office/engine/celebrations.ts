/**
 * Living office, phase B (docs/office/DESIGN.md "B. Celebrations"): when a
 * push or PR lands, a bell rings on the shipping agent's desk and confetti
 * bursts over them; the trophy wall shows the day's tally.
 *
 * DOM-free: the physics and placement helpers are pure, and `Celebrations`
 * (owned by OfficeState) only holds state. Drawing lives in
 * celebrationRender.ts, the sound in celebrationSound.ts.
 */

import type { DailyStats } from '../../../../core/src/messages.js';
import {
  BELL_DESK_DEPTH,
  BELL_FURNITURE_TYPE,
  BELL_SHOW_SEC,
  BELL_WOBBLE_HZ,
  BELL_WOBBLE_PX,
  BELL_WOBBLE_SEC,
  CONFETTI_COLORS,
  CONFETTI_DRAG,
  CONFETTI_FADE_SEC,
  CONFETTI_GRAVITY,
  CONFETTI_LIFE_MIN_FRACTION,
  CONFETTI_LIFE_SEC,
  CONFETTI_PARTICLE_COUNT,
  CONFETTI_SPEED_MAX,
  CONFETTI_SPEED_MIN,
  CONFETTI_SPREAD_RAD,
  CONFETTI_TERMINAL_VY,
} from '../../constants.js';
import { metricsOf } from '../agentLook.js';
import type { Character, FurnitureInstance, PlacedFurniture, Seat, SpriteData } from '../types.js';
import { Direction, TILE_SIZE } from '../types.js';
import type { ShipCandidate, ShipEvent, ShipSignal, ShipTally } from './shipEvents.js';
import { attributeShip, newShipEvents, noteShipTool, tallyOf } from './shipEvents.js';

// ── Confetti ─────────────────────────────────────────────────────

export interface ConfettiParticle {
  /** World position (sprite px). */
  x: number;
  y: number;
  /** Velocity (sprite px/s). */
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** Index into CONFETTI_COLORS. */
  color: number;
  /** Flip phase offset (0..1), so flakes don't twinkle in step. */
  phase: number;
}

export interface ConfettiBurst {
  particles: ConfettiParticle[];
}

/** A burst of CONFETTI_PARTICLE_COUNT flakes from (x, y), thrown up in a cone. */
export function spawnConfetti(x: number, y: number, random: () => number): ConfettiBurst {
  const particles: ConfettiParticle[] = [];
  for (let i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
    const angle = -Math.PI / 2 + (random() - 0.5) * CONFETTI_SPREAD_RAD;
    const speed = CONFETTI_SPEED_MIN + random() * (CONFETTI_SPEED_MAX - CONFETTI_SPEED_MIN);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: 0,
      life:
        CONFETTI_LIFE_SEC *
        (CONFETTI_LIFE_MIN_FRACTION + random() * (1 - CONFETTI_LIFE_MIN_FRACTION)),
      color: i % CONFETTI_COLORS.length,
      phase: random(),
    });
  }
  return { particles };
}

/** One physics step: gravity up to a paper-like terminal fall speed, sideways drag. */
export function stepParticle(p: ConfettiParticle, dt: number): void {
  p.vy = Math.min(p.vy + CONFETTI_GRAVITY * dt, CONFETTI_TERMINAL_VY);
  p.vx *= Math.exp(-CONFETTI_DRAG * dt);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.age += dt;
}

/** Opacity: full, then fading out over the last CONFETTI_FADE_SEC of its life. */
export function particleAlpha(p: ConfettiParticle): number {
  const left = p.life - p.age;
  if (left <= 0) return 0;
  return Math.min(1, left / CONFETTI_FADE_SEC);
}

/** Advance a burst; drops dead flakes. False once every flake is gone. */
export function stepConfetti(burst: ConfettiBurst, dt: number): boolean {
  for (const p of burst.particles) stepParticle(p, dt);
  burst.particles = burst.particles.filter((p) => p.age < p.life);
  return burst.particles.length > 0;
}

// ── Bell ─────────────────────────────────────────────────────────

/** The bell's sideways swing (whole sprite px) at `t` s: a decaying ring. */
export function bellWobble(t: number): number {
  if (t < 0 || t >= BELL_WOBBLE_SEC) return 0;
  const amp = BELL_WOBBLE_PX * (1 - t / BELL_WOBBLE_SEC);
  return Math.round(Math.sin(2 * Math.PI * BELL_WOBBLE_HZ * t) * amp);
}

const FACING: Record<Direction, { dc: number; dr: number }> = {
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

/** Desk tops and what already stands on them, by `col,row`. */
export interface DeskIndex {
  /** Desk tile → the desk's depth (its bottom edge, px). */
  deskZ: Map<string, number>;
  /** Desk tiles that are its top, not its walk-behind background rows: what
   *  the eye reads as the desk surface (a 3×2 desk's lower row). */
  top: Set<string>;
  /** Tiles a surface item (monitor, laptop, mug...) already stands on. */
  surface: Set<string>;
}

export type EntryOf = (type: string) =>
  | {
      footprintW: number;
      footprintH: number;
      isDesk?: boolean;
      canPlaceOnSurfaces?: boolean;
      backgroundTiles?: number;
      sprite: SpriteData;
    }
  | undefined;

export function deskIndex(furniture: readonly PlacedFurniture[], entryOf: EntryOf): DeskIndex {
  const deskZ = new Map<string, number>();
  const top = new Set<string>();
  const surface = new Set<string>();
  for (const item of furniture) {
    const e = entryOf(item.type);
    if (!e || (!e.isDesk && !e.canPlaceOnSurfaces)) continue;
    const z = item.row * TILE_SIZE + e.sprite.length;
    for (let dr = 0; dr < e.footprintH; dr++) {
      for (let dc = 0; dc < e.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (!e.isDesk) {
          surface.add(key);
          continue;
        }
        deskZ.set(key, Math.max(z, deskZ.get(key) ?? -Infinity));
        if (dr >= (e.backgroundTiles ?? 0)) top.add(key);
      }
    }
  }
  return { deskZ, top, surface };
}

/**
 * Where the bell goes for an agent at `seat`: a free spot on the top of the
 * desk it faces (up to BELL_DESK_DEPTH tiles ahead, past a desk's background
 * row) — beside what's in front of it first, then right in front — else any
 * of those desk tiles, else the floor tile it faces. `zY` puts it over the
 * desk (like any surface item).
 */
export function bellSpot(seat: Seat, desks: DeskIndex): { col: number; row: number; zY: number } {
  const f = FACING[seat.facingDir] ?? FACING[Direction.DOWN];
  // Perpendicular to the facing direction: the desk's other tiles beside the front one.
  const side = f.dc === 0 ? { dc: 1, dr: 0 } : { dc: 0, dr: 1 };
  const tiles: Array<{ col: number; row: number }> = [];
  for (let d = 1; d <= BELL_DESK_DEPTH; d++) {
    const col = seat.seatCol + f.dc * d;
    const row = seat.seatRow + f.dr * d;
    tiles.push(
      { col: col + side.dc, row: row + side.dr },
      { col: col - side.dc, row: row - side.dr },
      { col, row },
    );
  }
  const key = (t: { col: number; row: number }) => `${t.col},${t.row}`;
  const pick =
    tiles.find((t) => desks.top.has(key(t)) && !desks.surface.has(key(t))) ??
    tiles.find((t) => desks.top.has(key(t))) ??
    tiles.find((t) => desks.deskZ.has(key(t))) ??
    tiles[2];
  const deskZ = desks.deskZ.get(key(pick));
  const floorZ = (pick.row + 1) * TILE_SIZE;
  return { ...pick, zY: deskZ !== undefined ? Math.max(floorZ, deskZ + 0.5) : floorZ };
}

/** A bell ringing on a desk: a furniture instance the renderer draws, nudged per frame. */
export interface Bell {
  agentId: number;
  t: number;
  baseX: number;
  instance: FurnitureInstance;
}

// ── State ────────────────────────────────────────────────────────

/** What OfficeState hands over when stats arrive. */
export interface CelebrationWorld {
  nowMs: number;
  characters: ReadonlyMap<number, Character>;
  seats: ReadonlyMap<string, Seat>;
  furniture: readonly PlacedFurniture[];
  entryOf: EntryOf;
}

export class Celebrations {
  /** Today's tally so far; null until the first dailyStats (the baseline). */
  private tally: ShipTally | null = null;
  private readonly signals = new Map<number, ShipSignal>();
  bells: Bell[] = [];
  bursts: ConfettiBurst[] = [];
  /** Confetti RNG ([0, 1)). Tests seed it. */
  random: () => number = () => Math.random();

  /** Distinct PRs and pushes today (the trophy wall's tally). */
  get prCount(): number {
    return this.tally?.prCount ?? 0;
  }
  get pushCount(): number {
    return this.tally?.pushCount ?? 0;
  }

  /** A tool started (sub-agents report under their parent): attribution input. */
  noteTool(agentId: number, status: string, nowMs: number): void {
    this.signals.set(agentId, noteShipTool(this.signals.get(agentId), status, nowMs));
  }

  forgetAgent(agentId: number): void {
    this.signals.delete(agentId);
  }

  /**
   * New stats: celebrate what's new (bell + confetti at whoever shipped it)
   * and keep the tally for the trophies. Returns the new ship events.
   */
  onDailyStats(stats: DailyStats, world: CelebrationWorld): ShipEvent[] {
    const events = newShipEvents(this.tally, stats);
    this.tally = tallyOf(stats);
    if (events.length === 0) return events;
    const candidates: ShipCandidate[] = [];
    for (const ch of world.characters.values()) {
      if (ch.isSubagent || ch.leaving || ch.matrixEffect === 'despawn') continue;
      candidates.push({ id: ch.id, repo: ch.directoryName });
    }
    let desks: DeskIndex | null = null;
    for (const event of events) {
      const id = attributeShip(event, candidates, this.signals, world.nowMs);
      const ch = id !== null ? world.characters.get(id) : undefined;
      if (!ch) continue;
      // From over the head: a chibi's (-CONFETTI_ORIGIN_DY) or a Clawd's lower one.
      this.bursts.push(spawnConfetti(ch.x, ch.y - metricsOf(ch).confettiRise, this.random));
      const seat = ch.seatId ? world.seats.get(ch.seatId) : undefined;
      const bell = world.entryOf(BELL_FURNITURE_TYPE);
      if (!seat || !bell) continue;
      desks ??= deskIndex(world.furniture, world.entryOf);
      this.ringBell(ch.id, bellSpot(seat, desks), bell.sprite);
    }
    return events;
  }

  /** Put a bell on the desk (one per agent: ringing again restarts it). */
  private ringBell(
    agentId: number,
    spot: { col: number; row: number; zY: number },
    sprite: SpriteData,
  ): void {
    const x = spot.col * TILE_SIZE;
    const y = (spot.row + 1) * TILE_SIZE - sprite.length;
    this.bells = this.bells.filter((b) => b.agentId !== agentId);
    this.bells.push({ agentId, t: 0, baseX: x, instance: { sprite, x, y, zY: spot.zY } });
  }

  /** The bells to draw this frame (appended to the furniture instances). */
  bellInstances(): FurnitureInstance[] {
    return this.bells.map((b) => b.instance);
  }

  /** Advance the effects. True when a bell came or went (furniture to rebuild). */
  update(dt: number): boolean {
    for (const bell of this.bells) {
      bell.t += dt;
      bell.instance.x = bell.baseX + bellWobble(bell.t);
    }
    const before = this.bells.length;
    this.bells = this.bells.filter((b) => b.t < BELL_SHOW_SEC);
    if (this.bursts.length > 0) this.bursts = this.bursts.filter((b) => stepConfetti(b, dt));
    return this.bells.length !== before;
  }
}
