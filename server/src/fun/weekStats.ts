/**
 * The week wall (docs/office/DESIGN.md, phase E): the last 7 local days' totals,
 * oldest first and today last, for the wall calendar and the growing plants.
 *
 * Past days come from the daily files ProgressTracker writes
 * (~/.pixel-agents/daily/<YYYY-MM-DD>.json), read once per date; today comes from
 * the live `dailyStats` broadcasts (its file is only written every few seconds).
 * A `weekStats` goes out whenever today's totals change and to every client that
 * connects.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DailyStats, WeekDay, WeekStats } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { WEEK_STATS_DAYS } from './funConstants.js';

/** Local calendar date, YYYY-MM-DD. */
export function localDateKey(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The last `count` local dates up to and including `now`'s, oldest first. */
export function lastLocalDates(now: number, count = WEEK_STATS_DAYS): string[] {
  const dates: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // midday: DST shifts never skip or repeat a date
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    dates.push(localDateKey(day.getTime()));
  }
  return dates;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/** A daily file's (or dailyStats message's) PR, push and active-time totals. */
export function weekDayFrom(date: string, raw: unknown): WeekDay {
  const day: WeekDay = { date, prs: 0, pushes: 0, activeMs: 0 };
  if (typeof raw !== 'object' || raw === null) return day;
  const file = raw as Record<string, unknown>;
  if (Array.isArray(file.prs)) {
    day.prs = file.prs.filter((p) => typeof p === 'object' && p !== null).length;
  }
  if (Array.isArray(file.pushes)) {
    for (const p of file.pushes) {
      if (typeof p === 'object' && p !== null)
        day.pushes += count((p as { count?: unknown }).count);
    }
  }
  day.activeMs = count(file.activeMs);
  return day;
}

/** One day's totals from <dir>/<date>.json; zeros when missing or unreadable. */
export function readWeekDay(dir: string | null, date: string): WeekDay {
  if (dir === null) return weekDayFrom(date, null);
  try {
    return weekDayFrom(date, JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf-8')));
  } catch {
    return weekDayFrom(date, null);
  }
}

export interface WeekStatsOptions {
  /** The daily files' directory; null: none (today's live totals only). */
  dailyDir: string | null;
  now?: () => number;
}

export class WeekStatsTracker {
  private readonly pastDays = new Map<string, WeekDay>();
  private today: WeekDay | undefined;
  private lastSent = '';
  private readonly now: () => number;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: WeekStatsOptions,
  ) {
    this.now = options.now ?? Date.now;
    store.on('broadcast', this.onBroadcast);
  }

  /** The week as of now. */
  snapshot(): WeekStats {
    const dates = lastLocalDates(this.now());
    const todayKey = dates[dates.length - 1];
    const days = dates.map((date) => {
      if (date === todayKey) {
        if (this.today?.date !== date) this.today = readWeekDay(this.options.dailyDir, date);
        return { ...this.today };
      }
      let day = this.pastDays.get(date);
      if (!day) {
        day = readWeekDay(this.options.dailyDir, date);
        this.pastDays.set(date, day);
      }
      return { ...day };
    });
    // Forget dates that fell off the week.
    for (const date of this.pastDays.keys()) {
      if (!dates.includes(date)) this.pastDays.delete(date);
    }
    return { type: 'weekStats', days };
  }

  dispose(): void {
    this.store.off('broadcast', this.onBroadcast);
  }

  /** Today's totals changed (or the day rolled over): send the week if it moved. */
  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    if (message.type !== 'dailyStats') return;
    const stats = message as unknown as DailyStats;
    if (typeof stats.date !== 'string') return;
    if (this.today && this.today.date !== stats.date && this.today.date < stats.date) {
      // Yesterday's last live totals are its final ones.
      this.pastDays.set(this.today.date, this.today);
    }
    this.today = weekDayFrom(stats.date, stats);
    const week = this.snapshot();
    const key = JSON.stringify(week.days);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.store.broadcast({ ...week });
  };
}
