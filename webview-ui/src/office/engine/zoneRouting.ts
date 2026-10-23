/**
 * The living office's destination rules (docs/office/DESIGN.md), as pure
 * functions: which room a character's signals send it to, how long it keeps a
 * destination before switching (hysteresis, clock injected), and which free
 * place in which zone it takes (crowding overflow). OfficeState owns the state
 * and the walking; this module only decides.
 */

import {
  SMOKE_LONG_COMMAND_SEC,
  ZONE_ASK_USER_TOOL_NAME,
  ZONE_HOLD_MIN_SEC,
  ZONE_SHELL_TOOL_NAMES,
} from '../../constants.js';
import type { OfficeZones, ZonePlace } from '../zones.js';
import { ZoneLabel } from '../zones.js';

export const Destination = {
  /** Its own desk: today's active behaviour (the desk FSM). */
  DESK: 'desk',
  /** Nothing applies: today's idle behaviour (the desk FSM). */
  IDLE: 'idle',
  LOUNGE: 'lounge',
  MEETING: 'meeting',
  /** A permission request: knock on Ansh's door (phase M). */
  KNOCK: 'knock',
  SERVER: 'server',
  /** Waiting on the user. */
  SMOKE: 'smoke',
  /** A mid-work smoke: a long-running command, or a break after long work. */
  BREAK: 'break',
  /** A Café coffee run at a gap between tools (coffeeRuns.ts). */
  COFFEE: 'coffee',
} as const;
export type Destination = (typeof Destination)[keyof typeof Destination];

/** Both kinds of cigarette break (they share the Smoke spots). */
export function isSmokeDestination(d: Destination): boolean {
  return d === Destination.SMOKE || d === Destination.BREAK;
}

/** What the webview already knows about an agent, reduced to the rules' inputs. */
export interface DestinationSignals {
  /** Asleep (agentSleep) and not working. */
  sleeping: boolean;
  /** A permission request is pending. */
  permission: boolean;
  /** A live AskUserQuestion tool. */
  askingUser: boolean;
  /** A live shell tool while the stage track is in `test` (tests, builds, checks). */
  testing: boolean;
  /** A live shell command, not a test/build, running longer than SMOKE_LONG_COMMAND_SEC. */
  longCommand: boolean;
  /** On a mid-work break (smokeBreaks.ts). */
  onBreak: boolean;
  /** On a Café coffee run (coffeeRuns.ts). */
  coffeeRun?: boolean;
  /** agentStatus active. */
  active: boolean;
  /** agentStatus waiting: the turn ended, it waits on the user. */
  waiting: boolean;
  /** Paused by a usage limit (agentLimit): not waiting on the user. */
  paused?: boolean;
}

/** What the layout offers beyond the signals. */
export interface DestinationOptions {
  /** The layout has an `Ansh` Area with somewhere to knock: permission
   *  requests go to its door instead of the Meeting room. */
  anshDoor?: boolean;
}

/** The rules table, first match wins. */
export function pickDestination(
  s: DestinationSignals,
  options: DestinationOptions = {},
): Destination {
  // A usage-limit pause is nobody's to answer: it waits at its desk -- not on
  // the smoking terrace, and not dozing in the Lounge -- until the reset.
  if (s.paused && !s.active && !s.permission && !s.askingUser) return Destination.DESK;
  if (s.sleeping) return Destination.LOUNGE;
  // A question is asked in the Meeting room, even with a permission pending.
  if (s.askingUser) return Destination.MEETING;
  if (s.permission) return options.anshDoor ? Destination.KNOCK : Destination.MEETING;
  if (s.testing) return Destination.SERVER;
  if (s.active && (s.longCommand || s.onBreak)) return Destination.BREAK;
  if (s.active && s.coffeeRun) return Destination.COFFEE;
  if (s.active) return Destination.DESK;
  if (s.waiting) return Destination.SMOKE;
  return Destination.IDLE;
}

/** A live tool: its name and when it started (office-clock seconds). */
export interface LiveTool {
  name: string | null;
  startedAt: number;
}

/** The tool half of the signals, from the agent's live (not done) tools at `now`. */
export function liveToolSignals(
  liveTools: Iterable<LiveTool>,
  phase: string | undefined,
  now: number,
): Pick<DestinationSignals, 'askingUser' | 'testing' | 'longCommand'> {
  let askingUser = false;
  let shell = false;
  let longShell = false;
  for (const tool of liveTools) {
    if (tool.name === ZONE_ASK_USER_TOOL_NAME) askingUser = true;
    if (tool.name !== null && ZONE_SHELL_TOOL_NAMES.includes(tool.name)) {
      shell = true;
      if (now - tool.startedAt > SMOKE_LONG_COMMAND_SEC) longShell = true;
    }
  }
  const testing = shell && phase === 'test';
  return { askingUser, testing, longCommand: longShell && !testing };
}

/** A destination and when it was chosen (office-clock seconds). */
export interface DestinationIntent {
  kind: Destination;
  since: number;
}

/**
 * Hysteresis: a destination is kept at least `holdSec` before switching, so a
 * burst of tools doesn't make a character pace back and forth. Going back to
 * its desk (work resumed), to the Meeting room or to Ansh's door (someone
 * needs the user) is never held up, and nor is leaving a coffee run (a detour,
 * called off at once). Returns `current` itself while it is kept, a new intent
 * on a switch (or the first one, when there is none yet).
 */
export function holdDestination(
  current: DestinationIntent | undefined,
  wanted: Destination,
  now: number,
  holdSec = ZONE_HOLD_MIN_SEC,
): DestinationIntent {
  if (!current) return { kind: wanted, since: now };
  if (current.kind === wanted) return current;
  if (
    wanted === Destination.DESK ||
    wanted === Destination.MEETING ||
    wanted === Destination.KNOCK ||
    current.kind === Destination.COFFEE
  ) {
    return { kind: wanted, since: now };
  }
  if (now - current.since >= holdSec) return { kind: wanted, since: now };
  return current;
}

/**
 * Zones a destination tries, in order — the first is the destination's own
 * room, the rest its crowding overflow. Empty: no room (the desk FSM).
 */
export const DESTINATION_ZONES: Record<Destination, readonly ZoneLabel[]> = {
  [Destination.DESK]: [],
  [Destination.IDLE]: [],
  [Destination.LOUNGE]: [ZoneLabel.LOUNGE, ZoneLabel.CAFE],
  [Destination.MEETING]: [ZoneLabel.MEETING],
  // Ansh's door; with every knock spot taken, the request waits in Meeting.
  [Destination.KNOCK]: [ZoneLabel.ANSH, ZoneLabel.MEETING],
  [Destination.SERVER]: [ZoneLabel.SERVER],
  [Destination.SMOKE]: [ZoneLabel.SMOKE, ZoneLabel.CAFE],
  // A mid-work smoke never overflows: with the terrace full it stays at work.
  [Destination.BREAK]: [ZoneLabel.SMOKE],
  // The Café counter (OfficeState passes the counter places as the Café's).
  [Destination.COFFEE]: [ZoneLabel.CAFE],
};

export type PlaceChoice =
  /** A free place: go there. */
  | { kind: 'place'; place: ZonePlace }
  /** The room and its overflow are full: stay at the desk. */
  | { kind: 'full' }
  /** The layout has no such room (or it's not a room destination): skip it. */
  | { kind: 'absent' };

/**
 * Crowding: the free place nearest `from` in the destination's room, else in
 * its overflow rooms in order. `isTaken` says whether a place is in use (a
 * seat someone holds as a desk or a destination, a reserved spot).
 */
export function choosePlace(
  zones: OfficeZones,
  destination: Destination,
  from: { col: number; row: number },
  isTaken: (place: ZonePlace) => boolean,
): PlaceChoice {
  const order = DESTINATION_ZONES[destination];
  const own = order.length > 0 ? zones.zones.get(order[0]) : undefined;
  if (!own || own.places.length === 0) return { kind: 'absent' };
  for (const label of order) {
    const zone = zones.zones.get(label);
    if (!zone) continue;
    let best: ZonePlace | null = null;
    let bestDist = Infinity;
    // Ansh's door is a queue: its knock spots are taken front rank first.
    const inOrder = label === ZoneLabel.ANSH;
    for (const place of zone.places) {
      if (isTaken(place)) continue;
      if (inOrder) {
        best = place;
        break;
      }
      const d = Math.abs(place.col - from.col) + Math.abs(place.row - from.row);
      if (d < bestDist) {
        best = place;
        bestDist = d;
      }
    }
    if (best) return { kind: 'place', place: best };
  }
  return { kind: 'full' };
}
