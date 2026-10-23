/**
 * Usage-limit detection (best effort), as pure functions.
 *
 * When the subscription's session or weekly limit is hit, Claude Code stops
 * the turn and the session waits until the limit resets. Three sources say so:
 *
 * - The transcript: an assistant record with `isApiErrorMessage: true`, e.g.
 *   `{ error: 'rate_limit', apiError: 'usage_limit_reached', apiErrorStatus: 429,
 *      quotaLimits: { status: 'rejected', resetsAt: <epoch s>, rateLimitType: 'five_hour' },
 *      message: { model: '<synthetic>', content: [{ type: 'text',
 *        text: "You've hit your session limit · resets 6:30pm (Asia/Kolkata)" }] } }`.
 * - The `StopFailure` hook (the turn ended on an API error): `error`
 *   (`rate_limit`, ...), `error_details`, `last_assistant_message`.
 * - A `Notification` hook whose message mentions a usage limit.
 *
 * Only the reason class and the reset time leave this module -- never the text.
 */

import { SYNTHETIC_MODEL, USAGE_LIMIT_MAX_AHEAD_MS } from './constants.js';

/** Which limit paused the agent: the 5-hour session window, the weekly cap,
 *  an unspecified usage limit, or a plain API rate limit. */
export type LimitReason = 'session' | 'weekly' | 'usage' | 'rate';

export interface UsageLimitInfo {
  reason: LimitReason;
  /** When the limit lifts (epoch ms), when known. */
  resetsAt?: number;
}

/** Text that names a usage/rate limit. */
const LIMIT_TEXT =
  /usage limit|session limit|weekly limit|hit your (?:[\w-]+ )?limit|limit reached|rate.?limit|\b429\b/i;
/** Stricter, for Notification messages: a usage limit, not any rate limit. */
const USAGE_LIMIT_TEXT =
  /usage limit|session limit|weekly limit|hit your (?:[\w-]+ )?limit|limit reached/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  d: DAY_MS,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
};

/** "…|1760000000": the old CLI's usage-limit text carried the reset as epoch seconds. */
const EPOCH_SUFFIX = /\|\s*(\d{10,13})\b/;
/** "resets in 2 hours", "reset in 1h 12m", "resets in 45 minutes". */
const RELATIVE_RESET =
  /\bresets?\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i;
const RELATIVE_PART = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi;
/** "resets 6:30pm", "resets at 18:30", "resets 3am", "resets Oct 20, 9am",
 *  "resets on Oct 20 at 9:00 AM". Local time. */
const ABSOLUTE_RESET =
  /\bresets?\s+(?:at\s+|on\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;

/** An epoch in seconds or milliseconds, as ms; undefined for anything else. */
function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/** Keep a reset time only when it is plausible: not absurdly far ahead. */
function plausible(resetsAt: number | undefined, now: number): number | undefined {
  if (resetsAt === undefined) return undefined;
  return resetsAt - now > USAGE_LIMIT_MAX_AHEAD_MS ? undefined : resetsAt;
}

/**
 * The reset time a limit message states, in epoch ms, or undefined.
 * Clock times are local; one already past today means tomorrow (and a past
 * month/day means next year).
 */
export function parseResetTime(text: string, now: number): number | undefined {
  if (!text) return undefined;

  const epoch = text.match(EPOCH_SUFFIX);
  if (epoch) return plausible(epochMs(Number(epoch[1])), now);

  const relative = text.match(RELATIVE_RESET);
  if (relative) {
    let total = 0;
    for (const part of relative[1].matchAll(RELATIVE_PART)) {
      total += Number(part[1]) * UNIT_MS[part[2][0].toLowerCase()];
    }
    return total > 0 ? plausible(now + total, now) : undefined;
  }

  const absolute = text.match(ABSOLUTE_RESET);
  if (!absolute) return undefined;
  const [, monthWord, dayText, hourText, minuteText, meridiem] = absolute;
  // A bare number ("resets 2") is not a time: it needs minutes or am/pm.
  if (minuteText === undefined && meridiem === undefined) return undefined;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    const pm = meridiem[0].toLowerCase() === 'p';
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }

  const base = new Date(now);
  const month = monthWord ? MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) : -1;
  if (month >= 0) {
    const day = Number(dayText);
    if (day < 1 || day > 31) return undefined;
    let at = new Date(base.getFullYear(), month, day, hour, minute, 0, 0);
    if (at.getTime() <= now) at = new Date(base.getFullYear() + 1, month, day, hour, minute, 0, 0);
    return plausible(at.getTime(), now);
  }
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return plausible(at.getTime(), now);
}

/** The limit class a message or a structured rateLimitType names. */
export function limitReasonOf(text: string, rateLimitType?: string): LimitReason {
  if (rateLimitType) {
    if (/five_hour|session/i.test(rateLimitType)) return 'session';
    if (/seven_day|week/i.test(rateLimitType)) return 'weekly';
  }
  if (/session limit|5-hour|five.hour/i.test(text)) return 'session';
  if (/weekly limit|week/i.test(text)) return 'weekly';
  if (USAGE_LIMIT_TEXT.test(text)) return 'usage';
  return 'rate';
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The text blocks of a message content (string or block array), joined. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => stringOf(objectOf(block)?.text) ?? '')
    .filter(Boolean)
    .join(' ');
}

/** The usage limit an API-error transcript record reports, or undefined. */
export function usageLimitFromRecord(record: unknown, now: number): UsageLimitInfo | undefined {
  const r = objectOf(record);
  if (!r || r.type !== 'assistant' || r.isApiErrorMessage !== true) return undefined;
  const message = objectOf(r.message);
  const text = contentText(message?.content ?? r.content);
  const quota = objectOf(r.quotaLimits);
  const info = objectOf(objectOf(r.apiErrorParams)?.rate_limit_info);
  const limited =
    r.error === 'rate_limit' ||
    r.apiError === 'usage_limit_reached' ||
    r.apiErrorStatus === 429 ||
    quota?.status === 'rejected' ||
    LIMIT_TEXT.test(text);
  if (!limited) return undefined;
  const resetsAt =
    plausible(epochMs(quota?.resetsAt), now) ??
    plausible(epochMs(info?.resetsAt), now) ??
    parseResetTime(text, now);
  const type = stringOf(quota?.rateLimitType) ?? stringOf(info?.rateLimitType);
  return withReset(limitReasonOf(text, type), resetsAt);
}

/** A real model response (not a synthetic error record): the API works again. */
export function isModelResponse(record: unknown): boolean {
  const r = objectOf(record);
  if (!r || r.type !== 'assistant' || r.isApiErrorMessage === true) return false;
  const model = stringOf(objectOf(r.message)?.model);
  return model !== undefined && model !== SYNTHETIC_MODEL;
}

/** The usage limit a `StopFailure` hook payload reports, or undefined (the
 *  turn failed for another reason: auth, billing, a server error, ...). */
export function usageLimitFromStopFailure(
  raw: Record<string, unknown>,
  now: number,
): UsageLimitInfo | undefined {
  const error = objectOf(raw.error);
  const errorType = stringOf(raw.error) ?? stringOf(error?.type);
  const text = [
    errorType,
    stringOf(error?.message),
    stringOf(raw.error_details),
    stringOf(raw.error_message),
    stringOf(raw.last_assistant_message),
    stringOf(raw.message),
  ]
    .filter(Boolean)
    .join(' \n ');
  const limited = errorType === 'rate_limit' || LIMIT_TEXT.test(text);
  if (!limited) return undefined;
  return withReset(limitReasonOf(text), parseResetTime(text, now));
}

/** The usage limit a Notification message announces, or undefined. */
export function usageLimitFromNotification(
  message: unknown,
  now: number,
): UsageLimitInfo | undefined {
  const text = stringOf(message);
  if (!text || !USAGE_LIMIT_TEXT.test(text)) return undefined;
  return withReset(limitReasonOf(text), parseResetTime(text, now));
}

function withReset(reason: LimitReason, resetsAt: number | undefined): UsageLimitInfo {
  return resetsAt === undefined ? { reason } : { reason, resetsAt };
}
