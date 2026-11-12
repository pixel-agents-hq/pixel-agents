/**
 * The greeter becoming the tutorial's agent (OfficeState.handoff): on the
 * tutorial's yes, the greeter walks to the nearest free seat that faces
 * sideways (fewest steps; any seat where none does), so it sits in profile
 * beside where it stood, and only
 * then is the Guide's session started (`onSeated`, with the seat). When the Guide's
 * agent joins this office, it takes that seat and the greeter's place without
 * a spawn effect: one character, never a despawn and a respawn.
 *
 * The seat is held while the greeter walks, so no other agent takes it. Only
 * the office that said yes walks its greeter; every other office sees the Guide
 * join as any agent does.
 */

import { TUTORIAL_NICKNAME } from '../../../../core/src/tutorial/quests.js';
import type { Character, Seat } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import { walkAlong } from './characters.js';

/** What the hand-off needs from the office. */
export interface HandoffHost {
  greeter(): Character | null;
  /** Every seat no one holds. */
  freeSeats(): string[];
  seat(id: string): Seat | undefined;
  /** The greeter's way to a seat's tile (empty when it is there or can't get there). */
  pathTo(ch: Character, seat: Seat): Steps;
}

type Steps = Array<{ col: number; row: number }>;

interface Walk {
  seatId: string;
  onSeated: (seatId?: string) => void;
  seated: boolean;
}

export class GreeterHandoff {
  private walk: Walk | null = null;
  private readonly host: HandoffHost;

  constructor(host: HandoffHost) {
    this.host = host;
  }

  /** The tutorial's yes: walk the greeter to the nearest free seat it can
   *  reach (a sideways one first) and sit it, then `onSeated(seatId)`. With no greeter or no seat it
   *  can reach, `onSeated()` at once (the Guide then joins as any agent does). */
  begin(onSeated: (seatId?: string) => void): void {
    this.cancel();
    const ch = this.host.greeter();
    const nearest = ch ? this.nearestSeat(ch) : null;
    if (!ch || !nearest) return onSeated();
    const { seatId, seat, path } = nearest;
    seat.assigned = true;
    ch.path = path;
    ch.moveProgress = 0;
    ch.frame = 0;
    ch.frameTimer = 0;
    this.walk = { seatId, onSeated, seated: false };
  }

  /** The free seat the fewest steps away among those facing left or right,
   *  else among all of them (ties: the office's seat order). */
  private nearestSeat(ch: Character): { seatId: string; seat: Seat; path: Steps } | null {
    let best: { seatId: string; seat: Seat; path: Steps } | null = null;
    let bestSideways: { seatId: string; seat: Seat; path: Steps } | null = null;
    for (const seatId of this.host.freeSeats()) {
      const seat = this.host.seat(seatId);
      if (!seat) continue;
      const there = ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
      const path = there ? [] : this.host.pathTo(ch, seat);
      if (!there && path.length === 0) continue;
      const found = { seatId, seat, path };
      if (!best || path.length < best.path.length) best = found;
      const sideways = seat.facingDir === Direction.LEFT || seat.facingDir === Direction.RIGHT;
      if (sideways && (!bestSideways || path.length < bestSideways.path.length)) {
        bestSideways = found;
      }
    }
    return bestSideways ?? best;
  }

  /** One frame: walk on, or sit down and start the Guide's session. */
  update(dt: number): void {
    const walk = this.walk;
    const ch = this.host.greeter();
    if (!walk || walk.seated || !ch) return;
    if (walkAlong(ch, dt)) return;
    const seat = this.host.seat(walk.seatId);
    ch.state = CharacterState.TYPE;
    ch.isActive = false;
    if (seat) ch.dir = seat.facingDir;
    ch.frame = 0;
    ch.frameTimer = 0;
    walk.seated = true;
    walk.onSeated(walk.seatId);
  }

  /** An agent joining this office: the tutorial's agent, while the greeter
   *  walks or sits for it, takes its seat (returned, freed for it); null for
   *  anyone else. */
  claim(nickname: string | undefined): string | null {
    const walk = this.walk;
    if (!walk || nickname !== TUTORIAL_NICKNAME) return null;
    this.cancel();
    return walk.seatId;
  }

  /** Drop the hand-off (the greeter left, or a new start begins): its seat is free again. */
  cancel(): void {
    const walk = this.walk;
    this.walk = null;
    const seat = walk ? this.host.seat(walk.seatId) : undefined;
    if (seat) seat.assigned = false;
  }
}
