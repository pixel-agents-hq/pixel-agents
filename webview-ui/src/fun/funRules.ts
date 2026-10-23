/**
 * The fun phase's decisions as pure functions (clock, randomness and office
 * state injected), so they unit-test in the Node runner: ritual timing, plant
 * stages, the week wall's cells, the pets' goals, ping-pong pairs, the weather
 * in the windows, the printer and the fish tank.
 */

import type { WeatherCondition, WeekDay } from '../../../core/src/messages.js';
import { localDateKey } from './festivals.js';
import {
  CALENDAR_CELL,
  FISH_FRAME_FAST_SEC,
  FISH_FRAME_SLOW_SEC,
  FISH_FRAME_STEP_SEC,
  PING_PONG_AFTER_SMOKE_SEC,
  PLANT_STAGE_2_PRS,
  PLANT_STAGE_3_PRS,
  PRINTED_EXTENSIONS,
  RITUAL_GRACE_MIN,
  WRITE_TOOL_NAME,
} from './funConstants.js';

// ── Rituals ────────────────────────────────────────────────────

/**
 * Is a daily ritual due? True from hour:minute local for `graceMin` minutes,
 * unless it already ran today (`lastRunDate`, a YYYY-MM-DD key).
 */
export function ritualDue(
  now: Date,
  hour: number,
  minute: number,
  lastRunDate: string | undefined,
  graceMin = RITUAL_GRACE_MIN,
): boolean {
  if (lastRunDate === localDateKey(now)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = hour * 60 + minute;
  return minutes >= start && minutes < start + graceMin;
}

/** The evening banner's text. */
export function eveningBannerText(prs: number, pushes: number): string {
  return `Today: ${prs} PR${prs === 1 ? '' : 's'} · ${pushes} push${pushes === 1 ? '' : 'es'} 🎉`;
}

// ── Growing plants / week wall ─────────────────────────────────

/** Monday of `now`'s week, as a YYYY-MM-DD key (the plants reset on Monday). */
export function weekStartKey(now: Date): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const back = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - back);
  return localDateKey(d);
}

/** PRs this week (Monday through today) from the week wall's days. */
export function weekPrCount(days: readonly WeekDay[], now: Date): number {
  const from = weekStartKey(now);
  const to = localDateKey(now);
  let n = 0;
  for (const day of days) if (day.date >= from && day.date <= to) n += day.prs;
  return n;
}

/** A plant's growth stage for this week's PR count: 0–2 → 1, 3–6 → 2, 7+ → 3. */
export function plantStage(prsThisWeek: number): 1 | 2 | 3 {
  if (prsThisWeek >= PLANT_STAGE_3_PRS) return 3;
  if (prsThisWeek >= PLANT_STAGE_2_PRS) return 2;
  return 1;
}

export interface CalendarCell {
  /** Grid column (Mon=0) and row in the calendar's 7×5 cell grid. */
  col: number;
  row: number;
  day: number;
  prs: number;
  today: boolean;
  /** Part of a run of consecutive days with PRs (2+). */
  streak: boolean;
}

/**
 * The wall calendar's lit cells for `now`'s month: days with PRs (from the
 * week's totals), plus today. Monday-first; a sixth week wraps into the first
 * row's empty cells, as paper calendars do.
 */
export function calendarCells(days: readonly WeekDay[], now: Date): CalendarCell[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const prsByDate = new Map(days.map((d) => [d.date, d.prs]));
  const todayKey = localDateKey(now);
  const slots = CALENDAR_CELL.cols * CALENDAR_CELL.rows;
  const out: CalendarCell[] = [];
  for (let day = 1; day <= now.getDate(); day++) {
    const key = localDateKey(new Date(year, month, day));
    const prs = prsByDate.get(key) ?? 0;
    const today = key === todayKey;
    if (prs === 0 && !today) continue;
    const idx = (offset + day - 1) % slots;
    const prevKey = localDateKey(new Date(year, month, day - 1));
    const nextKey = localDateKey(new Date(year, month, day + 1));
    const streak =
      prs > 0 && ((prsByDate.get(prevKey) ?? 0) > 0 || (prsByDate.get(nextKey) ?? 0) > 0);
    out.push({
      col: idx % CALENDAR_CELL.cols,
      row: Math.floor(idx / CALENDAR_CELL.cols),
      day,
      prs,
      today,
      streak,
    });
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function monthLabel(now: Date): string {
  return MONTHS[now.getMonth()];
}

// ── Smart pets ─────────────────────────────────────────────────

/** The agent with the most tool starts in the window (ties: the most recent start), among `eligible`. */
export function busiestAgent(
  starts: ReadonlyMap<number, readonly number[]>,
  now: number,
  windowMs: number,
  eligible: (id: number) => boolean,
): number | null {
  let best: number | null = null;
  let bestCount = 0;
  let bestLast = -Infinity;
  for (const [id, times] of starts) {
    if (!eligible(id)) continue;
    let count = 0;
    let last = -Infinity;
    for (const t of times) {
      if (now - t > windowMs || t > now) continue;
      count++;
      if (t > last) last = t;
    }
    if (count === 0) continue;
    if (count > bestCount || (count === bestCount && last > bestLast)) {
      best = id;
      bestCount = count;
      bestLast = last;
    }
  }
  return best;
}

export type GitcatGoal =
  | { kind: 'terrace'; agentId: number }
  | { kind: 'desk'; agentId: number }
  | { kind: 'nap'; agentId: number }
  | { kind: 'roam' };

/**
 * Gitcat's goal, first match wins: a terrace follow already under way; the
 * busiest agent's desk; a nap beside a sleeper when nobody is busy; else roam.
 */
export function gitcatGoal(s: {
  following: number | null;
  busiest: number | null;
  anyoneBusy: boolean;
  sleepers: readonly number[];
}): GitcatGoal {
  if (s.following !== null) return { kind: 'terrace', agentId: s.following };
  if (s.busiest !== null) return { kind: 'desk', agentId: s.busiest };
  if (!s.anyoneBusy && s.sleepers.length > 0) return { kind: 'nap', agentId: s.sleepers[0] };
  return { kind: 'roam' };
}

/** May Gitcat start following a smoker now? At most once per cooldown, by chance. */
export function mayFollowSmoker(
  lastFollowAt: number | null,
  now: number,
  cooldownSec: number,
  chance: number,
  rng: () => number,
): boolean {
  if (lastFollowAt !== null && now - lastFollowAt < cooldownSec) return false;
  return rng() < chance;
}

export type ClaudioGoal =
  { kind: 'celebrate'; agentId: number } | { kind: 'greet'; agentId: number } | { kind: 'roam' };

/** Claudio's goal: bounce around a shipper first, else greet a newcomer, else roam. */
export function claudioGoal(
  s: {
    celebrate: { agentId: number; until: number } | null;
    greet: { agentId: number; until: number } | null;
  },
  now: number,
): ClaudioGoal {
  if (s.celebrate && now < s.celebrate.until) {
    return { kind: 'celebrate', agentId: s.celebrate.agentId };
  }
  if (s.greet && now < s.greet.until) return { kind: 'greet', agentId: s.greet.agentId };
  return { kind: 'roam' };
}

/** A shell command that ships (the push / PR the dailyStats bump came from). */
export function isShipStatus(status: string): boolean {
  return /\bgit\s+push\b|\bgh\s+pr\s+create\b/i.test(status);
}

// ── Ping-pong ──────────────────────────────────────────────────

export interface RallyCandidate {
  id: number;
  /** Not working, not asleep, not leaving, not borrowed by another pastime. */
  idleAwake: boolean;
  /** Seconds at the Smoke spot so far (null: not smoking). */
  smokingSec: number | null;
  /** On a mid-work smoke break (it will go back to work). */
  midWorkBreak: boolean;
}

/**
 * Eligible for a rally: idle and awake, and not in the middle of a cigarette —
 * a waiting smoker counts once it has smoked PING_PONG_AFTER_SMOKE_SEC (it
 * stubs out, then goes). Mid-work breaks never count.
 */
export function rallyEligible(
  c: RallyCandidate,
  afterSmokeSec = PING_PONG_AFTER_SMOKE_SEC,
): boolean {
  if (!c.idleAwake || c.midWorkBreak) return false;
  return c.smokingSec === null || c.smokingSec >= afterSmokeSec;
}

/** Two players for a rally, or null: 2+ eligible, cooldown over, and the dice say so. */
export function pickRallyPair(
  candidates: readonly RallyCandidate[],
  lastRallyAt: number | null,
  now: number,
  cooldownSec: number,
  chance: number,
  rng: () => number,
): [number, number] | null {
  if (lastRallyAt !== null && now - lastRallyAt < cooldownSec) return null;
  const pool = candidates.filter((c) => rallyEligible(c)).map((c) => c.id);
  if (pool.length < 2) return null;
  if (rng() >= chance) return null;
  const i = Math.floor(rng() * pool.length) % pool.length;
  const rest = pool.filter((_, k) => k !== i);
  const j = Math.floor(rng() * rest.length) % rest.length;
  return [pool[i], rest[j]];
}

// ── Weather in the windows ─────────────────────────────────────

export interface WeatherVisual {
  /** Falling particles drawn in the panes. */
  particles: 'rain' | 'snow' | null;
  /** Particles per pane. */
  count: number;
  /** Grey cloud wash over the glass (0 = none). */
  cloudAlpha: number;
  /** Pale fog wash. */
  fogAlpha: number;
  /** Lightning flashes now and then. */
  lightning: boolean;
}

export function weatherVisual(condition: WeatherCondition, isDay: boolean): WeatherVisual {
  const night = isDay ? 1 : 0.6;
  switch (condition) {
    case 'clouds':
      return { particles: null, count: 0, cloudAlpha: 0.35 * night, fogAlpha: 0, lightning: false };
    case 'rain':
      return {
        particles: 'rain',
        count: 5,
        cloudAlpha: 0.3 * night,
        fogAlpha: 0,
        lightning: false,
      };
    case 'snow':
      return {
        particles: 'snow',
        count: 4,
        cloudAlpha: 0.2 * night,
        fogAlpha: 0,
        lightning: false,
      };
    case 'fog':
      return { particles: null, count: 0, cloudAlpha: 0, fogAlpha: 0.55 * night, lightning: false };
    case 'storm':
      return { particles: 'rain', count: 8, cloudAlpha: 0.5 * night, fogAlpha: 0, lightning: true };
    default:
      return { particles: null, count: 0, cloudAlpha: 0, fogAlpha: 0, lightning: false };
  }
}

// ── Printer / fish tank ────────────────────────────────────────

/** Does this tool start print a page? A Write of a .md / .pdf / .docx / .txt file. */
export function printsDocument(toolName: string | null | undefined, status: string): boolean {
  const name = toolName ?? (status.startsWith('Writing ') ? WRITE_TOOL_NAME : null);
  if (name !== WRITE_TOOL_NAME) return false;
  const ext = status.trim().match(/\.([a-z0-9]+)$/i)?.[1];
  return ext !== undefined && PRINTED_EXTENSIONS.includes(ext.toLowerCase());
}

/** The fish tank's frame time: faster bubbles with more agents at work. */
export function fishFrameInterval(activeAgents: number): number {
  return Math.max(FISH_FRAME_FAST_SEC, FISH_FRAME_SLOW_SEC - FISH_FRAME_STEP_SEC * activeAgents);
}
