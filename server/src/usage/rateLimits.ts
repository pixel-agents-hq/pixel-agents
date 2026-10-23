/**
 * Claude Code's subscription rate limits, as pure functions. The status line
 * is the only place Claude Code states them before a limit is hit: its stdin
 * JSON carries (Pro/Max only, after the session's first response)
 *
 *   rate_limits: {
 *     five_hour: { used_percentage: 23.5, resets_at: 1738425600 },  // 0-100, epoch s
 *     seven_day: { used_percentage: 41, resets_at: 1738857600 },
 *   }
 *
 * each window independently absent. Bundled into the status line script (it
 * prints a line from them) and used by the server to validate what the script
 * forwards -- one parser for both ends. No Node imports: it must bundle clean.
 */

import type { UsageWindow } from '../../../core/src/messages.js';

/** The windows the meter shows; each absent when unknown or already reset. */
export interface SubscriptionUsageWindows {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An epoch in seconds or milliseconds, as ms; undefined for anything else. */
function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value < 1e12 ? value * 1000 : value);
}

/** One window, or undefined unless both fields are usable. The percentage is
 *  clamped to 0-100: the bar has nowhere to draw anything else. */
function parseWindow(raw: unknown): UsageWindow | undefined {
  const w = objectOf(raw);
  const used = w?.used_percentage;
  const resetsAt = epochMs(w?.resets_at);
  if (typeof used !== 'number' || !Number.isFinite(used) || resetsAt === undefined) {
    return undefined;
  }
  return { usedPercentage: Math.min(100, Math.max(0, used)), resetsAt };
}

/**
 * The windows in a status line's `rate_limits` object, minus any that already
 * reset by `now` (Claude Code drops those too). Undefined when none is usable:
 * an API-key user, a session before its first response, or junk.
 */
export function parseRateLimits(raw: unknown, now: number): SubscriptionUsageWindows | undefined {
  const limits = objectOf(raw);
  if (!limits) return undefined;
  const out: SubscriptionUsageWindows = {};
  const fiveHour = parseWindow(limits.five_hour);
  if (fiveHour && fiveHour.resetsAt > now) out.fiveHour = fiveHour;
  const sevenDay = parseWindow(limits.seven_day);
  if (sevenDay && sevenDay.resetsAt > now) out.sevenDay = sevenDay;
  return out.fiveHour || out.sevenDay ? out : undefined;
}

/** "23%" -- whole percent, rounded down so 99.6 never reads as full. */
export function percentText(used: number): string {
  return `${Math.floor(used)}%`;
}
