import { facingDirection, type VisitSpot } from '../../../../core/src/layout/visitSpot.js';
import {
  BUILDOUT_WORK_TAIL_SEC,
  MESSAGE_SHOW_LINGER_MS,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import type { Character, CharacterVisit, Errand, VisitEnd, VisitStop } from '../types.js';
import { CharacterState } from '../types.js';
import { currentVisit, type VisitProgress } from './characters.js';

type Tile = { col: number; row: number };

/** What the visits need of the office (OfficeState supplies it). */
export interface VisitWorld {
  readonly characters: ReadonlyMap<number, Character>;
  /** One frame of `visit` for `ch` (characters.ts updateVisit, its own seat open). */
  walk(ch: Character, visit: CharacterVisit, dt: number): VisitProgress;
  /** A free tile beside `target` for `ch` to stand on, facing it: reachable
   *  from where it stands, not where anyone else stands or is headed. */
  spotBeside(ch: Character, target: readonly Tile[]): VisitSpot | null;
  /** Send an agent's character back to its seat (it drops its errands). */
  sendToSeat(agentId: number): void;
}

function newVisit(stops: VisitStop[], then: VisitEnd): CharacterVisit {
  return { stops, then, arrived: false, lingerLeft: 0 };
}

/** The server's Visit: at the bottom of the stack, ended by the server. */
class ServerVisit implements Errand {
  private readonly world: VisitWorld;
  readonly visit: CharacterVisit;

  constructor(world: VisitWorld, visit: CharacterVisit) {
    this.world = world;
    this.visit = visit;
  }

  step(ch: Character, dt: number): Exclude<VisitEnd, 'stay'> | null {
    const progress = this.world.walk(ch, this.visit, dt);
    if (progress === 'visiting') return null;
    return progress === 'over' && this.visit.then === 'seat' ? 'seat' : 'wander';
  }

  endsWithServerVisit(): boolean {
    return true;
  }
}

/** A Buildout's builder working beside its origin (local: outlives a server clear). */
class BuildoutWork implements Errand {
  private readonly world: VisitWorld;
  readonly visit: CharacterVisit;

  constructor(world: VisitWorld, visit: CharacterVisit) {
    this.world = world;
    this.visit = visit;
  }

  step(ch: Character, dt: number): Exclude<VisitEnd, 'stay'> | null {
    return this.world.walk(ch, this.visit, dt) === 'visiting' ? null : 'seat';
  }

  endsWithServerVisit(): boolean {
    return false;
  }
}

/** A Message show: the sender walks to each recipient in turn, re-aiming as
 *  it moves (local: outlives a server clear); a stop that can't be walked to
 *  is skipped, not the whole show. */
class MessageShow implements Errand {
  private readonly world: VisitWorld;
  readonly visit: CharacterVisit;

  constructor(world: VisitWorld, stops: VisitStop[]) {
    this.world = world;
    this.visit = newVisit(stops, 'seat');
  }

  step(ch: Character, dt: number): Exclude<VisitEnd, 'stay'> | null {
    if (!this.aim(ch)) return 'seat';
    const progress = this.world.walk(ch, this.visit, dt);
    if (progress === 'lost') {
      this.visit.stops.shift();
      this.visit.arrived = false;
      return this.aim(ch) ? null : 'seat';
    }
    return progress === 'over' ? 'seat' : null;
  }

  endsWithServerVisit(): boolean {
    return false;
  }

  /**
   * Aim the current stop at the tile beside its recipient — where that
   * character stands, or the tile it is walking to — re-aiming as it moves
   * until the sender arrives. Stops whose recipient left or can't be reached
   * are dropped. False once no stop is left.
   */
  aim(ch: Character): boolean {
    const visit = this.visit;
    for (;;) {
      const stop = visit.stops[0];
      if (!stop) return false;
      if (!stop.beside || visit.arrived) return true;
      const to = this.world.characters.get(stop.beside.agentId);
      const end = to?.path[to.path.length - 1];
      const at = end ?? (to ? { col: to.tileCol, row: to.tileRow } : null);
      if (to && to.matrixEffect !== 'despawn' && at) {
        if (stop.beside.at?.col === at.col && stop.beside.at.row === at.row) return true;
        const spot = this.world.spotBeside(ch, [at]);
        if (spot) {
          stop.col = spot.col;
          stop.row = spot.row;
          stop.dir = facingDirection(spot.facing);
          stop.beside.at = { col: at.col, row: at.row };
          return true;
        }
      }
      visit.stops.shift();
    }
  }
}

function topOf(ch: Character): Errand | undefined {
  const errands = ch.errands;
  return errands ? errands[errands.length - 1] : undefined;
}

/** Whether a character can be sent anywhere (not a helper, not leaving). */
function canGo(ch: Character | undefined): ch is Character {
  return !!ch && !ch.isSubagent && ch.matrixEffect !== 'despawn';
}

/**
 * The office's Visits, Message shows and Buildout work: each character's
 * errand stack (`Character.errands`) — the server Visit at the bottom, a
 * local errand pushed above it; the top one moves the character, and
 * finishing it uncovers the one below (walked again from where it stands),
 * else hands the character back to the usual FSM.
 */
export class VisitsController {
  /** The visit last asked of each agent (stops + end), so a repeat is recognized. */
  private readonly visitKeys = new Map<number, string>();

  private readonly world: VisitWorld;

  constructor(world: VisitWorld) {
    this.world = world;
  }

  /**
   * Send an agent's character on a Visit: through `stops` in order — walk to
   * each, face its way, stand there for its linger — then `then`: wander as
   * usual, stay at the last stop until end, or go back to its seat. Its
   * agent's work doesn't move it meanwhile. A repeat of the visit last asked
   * (a reconnect's snapshot re-sending it) changes nothing — whether it is
   * still under way, over, or ended here by the user's own command. False for
   * a character that can't go (none, a sub-agent, one leaving).
   */
  start(agentId: number, stops: readonly VisitStop[], then: VisitEnd): boolean {
    const ch = this.world.characters.get(agentId);
    if (!canGo(ch) || stops.length === 0) return false;
    const key = JSON.stringify({ stops, then });
    if (this.visitKeys.get(agentId) === key) return true;
    this.visitKeys.set(agentId, key);
    // Local errands under way give way, a Message's gist and all: the server's Visit wins.
    const stopsCopy = stops.map((s) => ({ ...s }));
    ch.errands = [new ServerVisit(this.world, newVisit(stopsCopy, then))];
    ch.saying = null;
    ch.seatTimer = 0;
    return true;
  }

  /** End an agent's server Visit, if it is on one: it wanders as usual, or
   *  heads to its seat when its agent is working. A local errand above it (a
   *  Message show, Buildout work) carries on, then goes back to its desk. A
   *  later visit, even the same one, goes. */
  end(agentId: number): void {
    this.visitKeys.delete(agentId);
    const ch = this.world.characters.get(agentId);
    const top = ch && topOf(ch);
    if (!ch || !top) return;
    ch.errands = ch.errands!.filter((e) => !e.endsWithServerVisit());
    if (top.endsWithServerVisit()) this.release(ch, 'wander');
  }

  /** Drop every errand of a character, and what it was saying (the user's
   *  word: a seat click, a walk command). */
  drop(ch: Character): void {
    ch.errands = undefined;
    ch.saying = null;
  }

  /** Forget an agent that left (its next visit, even the same one, goes). */
  forget(agentId: number): void {
    this.visitKeys.delete(agentId);
  }

  /**
   * Show a Message (`agentMessageShow`): the sender's character walks to a
   * tile beside each recipient's character in turn, faces it with `gist` in
   * its speech bubble for MESSAGE_SHOW_LINGER_MS, then goes back to its desk
   * — or to the server Visit it was on (Buildout work under way is dropped).
   * Recipients this office doesn't show (or that leave meanwhile, or can't be
   * reached) are skipped; with none to walk to, or `walk` false (reduced
   * motion), the gist shows where it stands. A show already under way walks
   * this one after it. False when the sender isn't here to show it.
   */
  showMessage(
    fromId: number,
    toIds: readonly number[],
    gist: string,
    opts: { walk: boolean } = { walk: true },
  ): boolean {
    const ch = this.world.characters.get(fromId);
    if (!canGo(ch)) return false;
    const lingerSec = MESSAGE_SHOW_LINGER_MS / 1000;
    const stops: VisitStop[] = opts.walk
      ? toIds
          .filter((id) => id !== fromId && this.world.characters.has(id))
          .map((agentId) => ({
            col: ch.tileCol,
            row: ch.tileRow,
            dir: ch.dir,
            lingerSec,
            beside: { agentId },
            say: gist,
          }))
      : [];
    const top = topOf(ch);
    if (top instanceof MessageShow) {
      top.visit.stops.push(...stops);
      if (stops.length === 0) ch.saying = { gist, left: lingerSec };
      return true;
    }
    if (stops.length > 0) {
      const show = new MessageShow(this.world, stops);
      if (show.aim(ch)) {
        // A builder's work is not taken up again after the show: its server Visit is.
        const under = (ch.errands ?? []).filter((e) => !(e instanceof BuildoutWork));
        ch.errands = [...under, show];
        ch.saying = null;
        ch.seatTimer = 0;
        return true;
      }
      // No one to walk to: it stays as it was.
    }
    ch.saying = { gist, left: lingerSec };
    return true;
  }

  /** Send a Buildout's builder to work beside `origin` for `lingerSec` (a
   *  local errand, like a Message show's). A Message show under way keeps its
   *  sender; a server Visit it was on resumes afterwards. */
  sendBuilder(agentId: number, origin: Tile, lingerSec: number): void {
    const ch = this.world.characters.get(agentId);
    if (!canGo(ch) || topOf(ch) instanceof MessageShow) return;
    const spot = this.world.spotBeside(ch, [origin]);
    if (!spot) return;
    const stop: VisitStop = {
      col: spot.col,
      row: spot.row,
      dir: facingDirection(spot.facing),
      lingerSec: lingerSec + BUILDOUT_WORK_TAIL_SEC,
      work: true,
    };
    const under = (ch.errands ?? []).filter((e) => e instanceof ServerVisit);
    ch.errands = [...under, new BuildoutWork(this.world, newVisit([stop], 'seat'))];
    ch.saying = null;
    ch.seatTimer = 0;
  }

  /** What an agent's character is saying right now (a Message's gist), if anything. */
  gistOf(agentId: number): string | null {
    const ch = this.world.characters.get(agentId);
    if (!ch) return null;
    const visit = currentVisit(ch);
    const said = visit?.arrived ? visit.stops[0]?.say : undefined;
    return said ?? ch.saying?.gist ?? null;
  }

  /** The stop an agent's character is headed for or standing at, and whether it
   *  is there; null when it is on no visit. */
  stopOf(agentId: number): { stop: VisitStop; arrived: boolean } | null {
    const ch = this.world.characters.get(agentId);
    const visit = ch ? currentVisit(ch) : null;
    const stop = visit?.stops[0];
    return visit && stop ? { stop, arrived: visit.arrived } : null;
  }

  /** One frame of a character's top errand. False when it has none (the
   *  usual FSM moves it). */
  step(ch: Character, dt: number): boolean {
    const top = topOf(ch);
    if (!top) return false;
    const end = top.step(ch, dt);
    if (end) {
      ch.errands!.pop();
      const under = topOf(ch);
      if (under) {
        // Taken up again from where it stands: walked to its stop anew.
        under.visit.arrived = false;
        under.visit.lingerLeft = 0;
      } else this.release(ch, end);
    }
    return true;
  }

  /** Hand a character back to the usual FSM once its errands are over. */
  private release(ch: Character, then: Exclude<VisitEnd, 'stay'>): void {
    ch.errands = undefined;
    if (then === 'seat' && ch.seatId) {
      this.world.sendToSeat(ch.id);
      return;
    }
    ch.wanderTimer =
      WANDER_PAUSE_MIN_SEC + Math.random() * (WANDER_PAUSE_MAX_SEC - WANDER_PAUSE_MIN_SEC);
    ch.wanderCount = 0;
    if (ch.moveProgress > 0) {
      // Finish the step under way; the walk then decides what comes next.
      ch.path = ch.path.slice(0, 1);
      return;
    }
    ch.path = [];
    ch.state = CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
  }
}
