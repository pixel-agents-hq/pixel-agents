/**
 * Living-office ambience by the PC's local time (docs/office/DESIGN.md,
 * Ambience): the wall windows' time of day, the real clocks' hands, and the
 * night lights (which rooms dim). Pure: a Date in, furniture types, sprite
 * pixels and tile lists out, so every rule is testable without a canvas.
 */

import {
  AMBIENCE_DAWN_HOUR,
  AMBIENCE_DAY_HOUR,
  AMBIENCE_DUSK_HOUR,
  AMBIENCE_NIGHT_HOUR,
  CLOCK_HAND_COLOR,
  CLOCK_HOUR_HAND_RADIUS,
  CLOCK_MINUTE_HAND_RADIUS,
  CLOCK_PIVOT,
  WINDOW_DAY_TYPE,
  WINDOW_DUSK_TYPE,
  WINDOW_NIGHT_TYPE,
} from '../../constants.js';
import type { Character, PlacedFurniture, SpriteData } from '../types.js';

// ── Time of day ────────────────────────────────────────────────

export const TimeOfDay = { DAY: 'day', DUSK: 'dusk', NIGHT: 'night' } as const;
export type TimeOfDay = (typeof TimeOfDay)[keyof typeof TimeOfDay];

/** Day 07–17, dusk 17–19 and 06–07, night otherwise (local hours). */
export function timeOfDay(date: Date): TimeOfDay {
  const h = date.getHours();
  if (h >= AMBIENCE_DAY_HOUR && h < AMBIENCE_DUSK_HOUR) return TimeOfDay.DAY;
  if (h >= AMBIENCE_DUSK_HOUR && h < AMBIENCE_NIGHT_HOUR) return TimeOfDay.DUSK;
  if (h >= AMBIENCE_DAWN_HOUR && h < AMBIENCE_DAY_HOUR) return TimeOfDay.DUSK;
  return TimeOfDay.NIGHT;
}

const WINDOW_TYPES: Record<TimeOfDay, string> = {
  [TimeOfDay.DAY]: WINDOW_DAY_TYPE,
  [TimeOfDay.DUSK]: WINDOW_DUSK_TYPE,
  [TimeOfDay.NIGHT]: WINDOW_NIGHT_TYPE,
};
const ALL_WINDOW_TYPES = new Set(Object.values(WINDOW_TYPES));

/** The furniture type a window shows at this time of day; any other type as is. */
export function windowTypeFor(type: string, tod: TimeOfDay): string {
  return ALL_WINDOW_TYPES.has(type) ? WINDOW_TYPES[tod] : type;
}

/**
 * The layout's furniture with every window swapped to the time of day — only
 * to a variant the catalog has (`known`), so a pack without the dusk or night
 * window keeps what was placed. Returns the input itself when nothing changes
 * (no windows, or all already right), so the caller can skip work.
 */
export function withWindowsAt(
  furniture: readonly PlacedFurniture[],
  tod: TimeOfDay,
  known: (type: string) => boolean,
): PlacedFurniture[] {
  let out: PlacedFurniture[] | null = null;
  furniture.forEach((item, i) => {
    const type = windowTypeFor(item.type, tod);
    if (type === item.type || !known(type)) return;
    out ??= furniture.slice();
    out[i] = { ...item, type };
  });
  return out ?? (furniture as PlacedFurniture[]);
}

// ── Real clocks ────────────────────────────────────────────────

/** Hand angles in radians, clockwise from 12 o'clock: the minute hand by the
 *  minute (it moves once a minute), the hour hand by the hour and minute. */
export function clockHandAngles(date: Date): { hour: number; minute: number } {
  const m = date.getMinutes();
  const h = date.getHours() % 12;
  return {
    hour: ((h + m / 60) / 12) * Math.PI * 2,
    minute: (m / 60) * Math.PI * 2,
  };
}

/** A hand's tip, in sprite px: `radius` px from the pivot on each axis. */
export function handTip(angle: number, radius: { x: number; y: number }): { x: number; y: number } {
  return {
    x: CLOCK_PIVOT.x + Math.round(Math.sin(angle) * radius.x),
    y: CLOCK_PIVOT.y - Math.round(Math.cos(angle) * radius.y),
  };
}

/** The px of a 1-px line from the pivot to a tip (Bresenham), pivot first. */
export function handPixels(tip: { x: number; y: number }): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let x = CLOCK_PIVOT.x;
  let y = CLOCK_PIVOT.y;
  const dx = Math.abs(tip.x - x);
  const dy = -Math.abs(tip.y - y);
  const sx = x < tip.x ? 1 : -1;
  const sy = y < tip.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x, y });
    if (x === tip.x && y === tip.y) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** A light, opaque px (the clock's face, not its rim or the wall). */
function isFacePixel(color: string | undefined): boolean {
  if (!color || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.75;
}

/** The face with both hands drawn on it (only over face px, never the rim). */
export function drawClockHands(base: SpriteData, date: Date): SpriteData {
  const out = base.map((row) => row.slice());
  const { hour, minute } = clockHandAngles(date);
  for (const [angle, radius] of [
    [minute, CLOCK_MINUTE_HAND_RADIUS],
    [hour, CLOCK_HOUR_HAND_RADIUS],
  ] as const) {
    for (const p of handPixels(handTip(angle, radius))) {
      if (isFacePixel(base[p.y]?.[p.x])) out[p.y][p.x] = CLOCK_HAND_COLOR;
    }
  }
  return out;
}

const clockCache = new WeakMap<SpriteData, { key: string; sprite: SpriteData }>();

/** drawClockHands, kept until the minute changes (one sprite per face sprite),
 *  so the renderer's per-sprite cache redraws a clock once a minute. */
export function clockSprite(base: SpriteData, date: Date): SpriteData {
  const key = `${date.getHours()}:${date.getMinutes()}`;
  const hit = clockCache.get(base);
  if (hit && hit.key === key) return hit.sprite;
  const sprite = drawClockHands(base, date);
  clockCache.set(base, { key, sprite });
  return sprite;
}

// ── Night lights ──────────────────────────────────────────────

/** The tiles agents stand on (`col,row`). The greeter and the receptionist
 *  are props, not occupants: a room with only them in it is empty. */
export function occupiedTiles(
  characters: Iterable<Pick<Character, 'tileCol' | 'tileRow' | 'isGreeter' | 'isReceptionist'>>,
): Set<string> {
  const out = new Set<string>();
  for (const ch of characters) {
    if (!ch.isGreeter && !ch.isReceptionist) out.add(`${ch.tileCol},${ch.tileRow}`);
  }
  return out;
}

/**
 * The tiles of every labelled Area with nobody in it (`occupied`: the tiles
 * agents stand on, as `col,row`), grouped by label. The night lights dim
 * these further. Unlabelled tiles are never a room.
 */
export function emptyRoomTiles(
  areaTiles: ReadonlyArray<string | null> | undefined,
  cols: number,
  occupied: ReadonlySet<string>,
): Map<string, Array<{ col: number; row: number }>> {
  const rooms = new Map<string, Array<{ col: number; row: number }>>();
  if (!areaTiles || cols <= 0) return rooms;
  const busy = new Set<string>();
  areaTiles.forEach((label, i) => {
    if (!label) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (occupied.has(`${col},${row}`)) busy.add(label);
    let list = rooms.get(label);
    if (!list) rooms.set(label, (list = []));
    list.push({ col, row });
  });
  for (const label of busy) rooms.delete(label);
  return rooms;
}
