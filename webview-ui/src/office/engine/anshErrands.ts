/**
 * Ansh's errands between thoughts: the human things he does on his own when
 * the office has what they need — pet a pet, water a plant, make a coffee,
 * chat with the receptionist or the Manager, look out of a window, read the
 * whiteboard, feed the fish — plus the old quiet ones (a place in the Café,
 * Lounge or Server room; a stretch nearby).
 *
 * Pure and DOM-free like coffeeRuns.ts: which furniture an errand is for,
 * where to stand to do it, which errand to pick, what gets said and when, and
 * the watering can's pixels. OfficeState gathers the targets from the layout
 * and walks him there (OfficeNpcs.startAnshErrand).
 */

import {
  ANSH_BOARD_LINES,
  ANSH_BOARD_TYPE_PREFIXES,
  ANSH_COFFEE_LINES,
  ANSH_ERRAND_LINE_SEC,
  ANSH_ERRAND_REACH_ROWS,
  ANSH_ERRAND_REPLY_AT_SEC,
  ANSH_ERRAND_STAY_SEC,
  ANSH_ERRAND_WEIGHTS,
  ANSH_FISH_LINES,
  ANSH_FISH_TANK_TYPE_PREFIX,
  ANSH_MANAGER_EXCHANGES,
  ANSH_PET_LINES,
  ANSH_PLANT_LINES,
  ANSH_PLANT_TYPE_PREFIXES,
  ANSH_RECEPTION_EXCHANGES,
  ANSH_RECEPTION_REACH_TILES,
  ANSH_STRETCH_STAY_SEC,
  ANSH_WANDER_STAY_SEC,
  ANSH_WATER_DROP_COLOR,
  ANSH_WATERING_CAN_COLOR,
  ANSH_WATERING_CAN_DARK_COLOR,
  ANSH_WATERING_DROP_PERIOD_SEC,
  ANSH_WINDOW_LINES,
  ANSH_WINDOW_TYPE_PREFIX,
  COFFEE_MACHINE_TYPE_PREFIX,
} from '../../constants.js';
import type { LookMetrics } from '../agentLook.js';
import { lookMetrics } from '../agentLook.js';
import { Direction } from '../types.js';

export const AnshErrand = {
  PET: 'pet',
  PLANT: 'plant',
  COFFEE: 'coffee',
  RECEPTION: 'reception',
  MANAGER: 'manager',
  WINDOW: 'window',
  BOARD: 'board',
  FISH: 'fish',
  PLACE: 'place',
  STRETCH: 'stretch',
} as const;
export type AnshErrand = (typeof AnshErrand)[keyof typeof AnshErrand];

/** Who says a line (each is drawn over that character's head). */
export type NpcSpeaker = 'ansh' | 'receptionist' | 'manager';

type Tile = { col: number; row: number };

// ── Furniture ─────────────────────────────────────────────────

const startsWithAny = (type: string, prefixes: readonly string[]) =>
  prefixes.some((p) => type.startsWith(p));

/** The errand a furniture type is for, or null (most furniture is for none). */
export function furnitureErrand(type: string): AnshErrand | null {
  if (type.startsWith(COFFEE_MACHINE_TYPE_PREFIX)) return AnshErrand.COFFEE;
  if (type.startsWith(ANSH_FISH_TANK_TYPE_PREFIX)) return AnshErrand.FISH;
  if (type.startsWith(ANSH_WINDOW_TYPE_PREFIX)) return AnshErrand.WINDOW;
  if (startsWithAny(type, ANSH_BOARD_TYPE_PREFIXES)) return AnshErrand.BOARD;
  if (startsWithAny(type, ANSH_PLANT_TYPE_PREFIXES)) return AnshErrand.PLANT;
  return null;
}

/** Where to stand to do something at a spot, and the tile to look at there. */
export interface ErrandSpot extends Tile {
  look: Tile;
}

/**
 * Where to stand to use an item: in front of (below) it, the column nearest
 * its middle first, up to ANSH_ERRAND_REACH_ROWS further down (a machine on a
 * counter, a window above a cabinet); else beside it; else above it. Looking
 * at the item's edge right in front of him. Null when nothing around it is
 * walkable.
 */
export function standSpotFor(
  item: Tile,
  fp: { w: number; h: number },
  walkable: (col: number, row: number) => boolean,
): ErrandSpot | null {
  const mid = (fp.w - 1) / 2;
  const cols = Array.from({ length: fp.w }, (_, dc) => dc).sort(
    (a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b,
  );
  const bottom = item.row + fp.h - 1;
  for (let down = 1; down <= 1 + ANSH_ERRAND_REACH_ROWS; down++) {
    for (const dc of cols) {
      const col = item.col + dc;
      if (walkable(col, bottom + down))
        return { col, row: bottom + down, look: { col, row: bottom } };
    }
  }
  for (let dr = fp.h - 1; dr >= 0; dr--) {
    const row = item.row + dr;
    if (walkable(item.col - 1, row))
      return { col: item.col - 1, row, look: { col: item.col, row } };
    const right = item.col + fp.w;
    if (walkable(right, row)) return { col: right, row, look: { col: right - 1, row } };
  }
  for (const dc of cols) {
    const col = item.col + dc;
    if (walkable(col, item.row - 1))
      return { col, row: item.row - 1, look: { col, row: item.row } };
  }
  return null;
}

const STEP: Record<Direction, { dc: number; dr: number }> = {
  [Direction.UP]: { dc: 0, dr: -1 },
  [Direction.DOWN]: { dc: 0, dr: 1 },
  [Direction.LEFT]: { dc: -1, dr: 0 },
  [Direction.RIGHT]: { dc: 1, dr: 0 },
};

/**
 * Face to face with someone at a desk: the first walkable tile straight out
 * the way they face, past the desk between (at most ANSH_RECEPTION_REACH_TILES
 * out). Null when there is none — the caller stands him beside them instead.
 */
export function faceToFaceSpot(
  post: Tile & { facing: Direction },
  walkable: (col: number, row: number) => boolean,
): Tile | null {
  const { dc, dr } = STEP[post.facing];
  for (let k = 1; k <= ANSH_RECEPTION_REACH_TILES; k++) {
    const col = post.col + dc * k;
    const row = post.row + dr * k;
    if (walkable(col, row)) return { col, row };
  }
  return null;
}

/** The free walkable tile next to someone (4 sides, below first), or null. */
export function tileBeside(at: Tile, free: (col: number, row: number) => boolean): Tile | null {
  for (const { dc, dr } of [
    STEP[Direction.DOWN],
    STEP[Direction.LEFT],
    STEP[Direction.RIGHT],
    STEP[Direction.UP],
  ]) {
    if (free(at.col + dc, at.row + dr)) return { col: at.col + dc, row: at.row + dr };
  }
  return null;
}

// ── The pick ──────────────────────────────────────────────────

/** The targets the office offers for one kind of errand right now. */
export interface ErrandOption<T> {
  kind: AnshErrand;
  targets: readonly T[];
}

/**
 * One errand: a kind drawn by ANSH_ERRAND_WEIGHTS among the kinds with a
 * target (a bigger office doesn't make plants likelier than the coffee), then
 * one of its targets. The kind he did last is left out while another is on
 * offer. Null when nothing is. `random` returns [0, 1) like Math.random.
 */
export function pickErrand<T>(
  options: ReadonlyArray<ErrandOption<T>>,
  random: () => number,
  last: AnshErrand | null = null,
): { kind: AnshErrand; target: T } | null {
  let open = options.filter((o) => o.targets.length > 0 && ANSH_ERRAND_WEIGHTS[o.kind] > 0);
  if (open.length > 1 && last !== null) {
    const fresh = open.filter((o) => o.kind !== last);
    if (fresh.length > 0) open = fresh;
  }
  if (open.length === 0) return null;
  const total = open.reduce((sum, o) => sum + ANSH_ERRAND_WEIGHTS[o.kind], 0);
  let r = random() * total;
  let chosen = open[open.length - 1];
  for (const o of open) {
    r -= ANSH_ERRAND_WEIGHTS[o.kind];
    if (r < 0) {
      chosen = o;
      break;
    }
  }
  const i = Math.min(chosen.targets.length - 1, Math.floor(random() * chosen.targets.length));
  return { kind: chosen.kind, target: chosen.targets[i] };
}

// ── What gets said ────────────────────────────────────────────

export interface ErrandLine {
  who: NpcSpeaker;
  /** Seconds after he gets there. */
  atSec: number;
  text: string;
}

export interface ErrandScript {
  staySec: number;
  lines: ErrandLine[];
}

const oneOf = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/**
 * How long he stays and what is said, from the moment he gets there: one line
 * of his for an errand, his line and the answer for a chat, nothing for a
 * place or a stretch (the quiet ones).
 */
export function errandScript(
  kind: AnshErrand,
  random: () => number,
  ctx: { petName?: string; timeOfDay?: 'day' | 'dusk' | 'night' } = {},
): ErrandScript {
  const say = (text: string): ErrandLine[] => [{ who: 'ansh', atSec: 0, text }];
  const chat = (
    who: NpcSpeaker,
    exchanges: ReadonlyArray<readonly [string, string]>,
  ): ErrandLine[] => {
    const [mine, theirs] = oneOf(exchanges, random);
    return [
      { who: 'ansh', atSec: 0, text: mine },
      { who, atSec: ANSH_ERRAND_REPLY_AT_SEC, text: theirs },
    ];
  };
  switch (kind) {
    case AnshErrand.PET:
      return {
        staySec: ANSH_ERRAND_STAY_SEC.pet,
        lines: say(oneOf(ANSH_PET_LINES, random).replaceAll('{pet}', ctx.petName || 'buddy')),
      };
    case AnshErrand.PLANT:
      return { staySec: ANSH_ERRAND_STAY_SEC.plant, lines: say(oneOf(ANSH_PLANT_LINES, random)) };
    case AnshErrand.COFFEE:
      return { staySec: ANSH_ERRAND_STAY_SEC.coffee, lines: say(oneOf(ANSH_COFFEE_LINES, random)) };
    case AnshErrand.RECEPTION:
      return {
        staySec: ANSH_ERRAND_STAY_SEC.reception,
        lines: chat('receptionist', ANSH_RECEPTION_EXCHANGES),
      };
    case AnshErrand.MANAGER:
      return {
        staySec: ANSH_ERRAND_STAY_SEC.manager,
        lines: chat('manager', ANSH_MANAGER_EXCHANGES),
      };
    case AnshErrand.WINDOW:
      return {
        staySec: ANSH_ERRAND_STAY_SEC.window,
        lines: say(oneOf(ANSH_WINDOW_LINES[ctx.timeOfDay ?? 'day'], random)),
      };
    case AnshErrand.BOARD:
      return { staySec: ANSH_ERRAND_STAY_SEC.board, lines: say(oneOf(ANSH_BOARD_LINES, random)) };
    case AnshErrand.FISH:
      return { staySec: ANSH_ERRAND_STAY_SEC.fish, lines: say(oneOf(ANSH_FISH_LINES, random)) };
    case AnshErrand.PLACE:
      return { staySec: ANSH_WANDER_STAY_SEC, lines: [] };
    case AnshErrand.STRETCH:
      return { staySec: ANSH_STRETCH_STAY_SEC, lines: [] };
  }
}

/** A line on the clock: shown from `from` until `until` (office seconds). */
export interface TimedLine {
  who: NpcSpeaker;
  text: string;
  from: number;
  until: number;
}

/** A script's lines on the clock, starting when he got there. */
export function scheduleLines(lines: readonly ErrandLine[], arrivedAt: number): TimedLine[] {
  return lines.map((l) => ({
    who: l.who,
    text: l.text,
    from: arrivedAt + l.atSec,
    until: arrivedAt + l.atSec + ANSH_ERRAND_LINE_SEC,
  }));
}

/** What each speaker is saying at `now`: the latest line showing, per speaker. */
export function linesShowing(lines: readonly TimedLine[], now: number): TimedLine[] {
  const latest = new Map<NpcSpeaker, TimedLine>();
  for (const l of lines) {
    if (now < l.from || now >= l.until) continue;
    const cur = latest.get(l.who);
    if (!cur || l.from >= cur.from) latest.set(l.who, l);
  }
  return [...latest.values()];
}

// ── The watering can ──────────────────────────────────────────

/**
 * The watering can at the hand (px from the feet anchor, like the cup's) —
 * a 3×2 body with a spout toward the plant — and a drop falling from the spout
 * once every ANSH_WATERING_DROP_PERIOD_SEC, `t` seconds into the watering.
 */
export function wateringCanPixels(
  dir: Direction,
  t: number,
  hand: Pick<LookMetrics, 'handRise' | 'reachFront' | 'reachSide'> = lookMetrics('classic'),
): Array<{ dx: number; dy: number; color: string }> {
  const side = dir === Direction.LEFT || dir === Direction.RIGHT;
  const reach = side ? hand.reachSide : hand.reachFront - 1;
  // Toward the plant: right for RIGHT (and front/back views), left for LEFT.
  const sign = dir === Direction.LEFT ? -1 : 1;
  const left = dir === Direction.LEFT ? -reach - 3 : reach;
  const top = -hand.handRise;
  const out: Array<{ dx: number; dy: number; color: string }> = [];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      out.push({
        dx: left + x,
        dy: top + y,
        color: y === 1 ? ANSH_WATERING_CAN_DARK_COLOR : ANSH_WATERING_CAN_COLOR,
      });
    }
  }
  const spoutX = sign > 0 ? left + 3 : left - 1;
  out.push({ dx: spoutX, dy: top - 1, color: ANSH_WATERING_CAN_COLOR });
  // The drop: falls three px below the spout over a period, then the next.
  const phase = (t % ANSH_WATERING_DROP_PERIOD_SEC) / ANSH_WATERING_DROP_PERIOD_SEC;
  out.push({ dx: spoutX + sign, dy: top + Math.floor(phase * 3), color: ANSH_WATER_DROP_COLOR });
  return out;
}
