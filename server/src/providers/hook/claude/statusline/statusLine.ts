/**
 * Session bar: what Claude Code's `statusLine` command receives on stdin, the
 * one line it prints under the prompt, and the small snapshots it leaves in
 * ~/.pixel-agents/statusline/ for Nakama to read. Pure — the entry script
 * (nakama-statusline.ts) does the I/O.
 *
 * The payload is Claude Code's, not ours, so every field is optional and a
 * malformed one reads as "unknown", never as zero: a limit we could not read
 * must not show as 0% used. Nothing here may throw on any input — this runs
 * in every console after every message, and a status line that throws shows
 * nothing at all.
 */
import {
  STATUSLINE_ANSI,
  STATUSLINE_BAR_CELLS,
  STATUSLINE_BAR_EMPTY,
  STATUSLINE_BAR_FULL,
  STATUSLINE_DANGER_PCT,
  STATUSLINE_FALLBACK_NAME,
  STATUSLINE_LOCALE,
  STATUSLINE_SAME_WINDOW_SLACK_S,
  STATUSLINE_SEPARATOR,
  STATUSLINE_SHAPE_MAX_DEPTH,
  STATUSLINE_SHAPE_MAX_KEYS,
  STATUSLINE_UNKNOWN,
  STATUSLINE_WARN_PCT,
} from '../constants.js';

/** One plan limit (5-hour or 7-day window). */
export interface LimitWindow {
  /** 0-100. */
  usedPct: number;
  /** When the window resets, epoch seconds. */
  resetsAt?: number;
}

/** Prompt-cache health as Claude Code reports it. A cold cache means the next
 *  message re-sends the whole context at full price — the cost to watch. */
export interface PromptCache {
  warm?: boolean;
  ttl?: string;
  /** Epoch seconds. */
  expiresAt?: number;
  requests?: number;
  misses?: number;
  /** 0-1. */
  hitRatio?: number;
}

export interface StatusInput {
  /** Present only when it is safe to use as a file name. */
  sessionId?: string;
  /** The name the user gave the session (/rename), if any. */
  sessionName?: string;
  model?: { id?: string; displayName?: string };
  /** Effort level (low … max). */
  effort?: string;
  thinkingEnabled?: boolean;
  fastMode?: boolean;
  promptCache?: PromptCache;
  cwd?: string;
  contextUsedPct?: number;
  contextWindowSize?: number;
  costUsd?: number;
  durationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
}

export interface SessionSnapshot extends Omit<StatusInput, 'sessionId'> {
  v: 1;
  sessionId: string;
  updatedAt: number;
}

export interface UsageSnapshot {
  v: 1;
  updatedAt: number;
  sessionId?: string;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
}

export interface FormatOptions {
  /** IANA zone for reset times; the machine's zone when omitted. */
  timeZone?: string;
  /** ANSI colors (Claude Code renders them in the status line). */
  color: boolean;
}

/** Session ids become file names: no separators, no dots, bounded length. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Windows maps these names to devices, whatever the extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function obj(value: unknown): Json {
  return isObject(value) ? value : {};
}

function safeSessionId(value: unknown): string | undefined {
  const id = str(value);
  if (!id || !SAFE_SESSION_ID.test(id) || WINDOWS_DEVICE_NAME.test(id)) return undefined;
  return id;
}

function readLimit(value: unknown): LimitWindow | undefined {
  const raw = obj(value);
  const usedPct = num(raw['used_percentage']);
  if (usedPct === undefined) return undefined;
  const resetsAt = num(raw['resets_at']);
  return resetsAt === undefined ? { usedPct } : { usedPct, resetsAt };
}

function readPromptCache(value: unknown): PromptCache | undefined {
  if (!isObject(value)) return undefined;
  return {
    warm: bool(value['warm']),
    ttl: str(value['ttl']),
    expiresAt: num(value['expires_at']),
    requests: num(value['requests']),
    misses: num(value['misses']),
    hitRatio: num(value['hit_ratio']),
  };
}

/** Read the statusLine payload. Null only when it is not an object at all. */
export function parseStatusInput(raw: unknown): StatusInput | null {
  if (!isObject(raw)) return null;
  const model = obj(raw['model']);
  const workspace = obj(raw['workspace']);
  const cost = obj(raw['cost']);
  const context = obj(raw['context_window']);
  const limits = obj(raw['rate_limits']);
  const modelId = str(model['id']);
  const displayName = str(model['display_name']);

  return {
    sessionId: safeSessionId(raw['session_id']),
    sessionName: str(raw['session_name']),
    model: modelId || displayName ? { id: modelId, displayName } : undefined,
    effort: str(obj(raw['effort'])['level']),
    thinkingEnabled: bool(obj(raw['thinking'])['enabled']),
    fastMode: bool(raw['fast_mode']),
    promptCache: readPromptCache(raw['prompt_cache']),
    cwd: str(workspace['current_dir']) ?? str(raw['cwd']),
    contextUsedPct: num(context['used_percentage']),
    contextWindowSize: num(context['context_window_size']),
    costUsd: num(cost['total_cost_usd']),
    durationMs: num(cost['total_duration_ms']),
    linesAdded: num(cost['total_lines_added']),
    linesRemoved: num(cost['total_lines_removed']),
    fiveHour: readLimit(limits['five_hour']),
    sevenDay: readLimit(limits['seven_day']),
  };
}

/** Filled cells: any usage above zero shows at least one, a full bar means
 *  the whole window is spent. */
function bar(pct: number): string {
  const cellPct = 100 / STATUSLINE_BAR_CELLS;
  const full =
    pct <= 0 ? 0 : Math.max(1, Math.min(STATUSLINE_BAR_CELLS, Math.floor(pct / cellPct)));
  return (
    STATUSLINE_BAR_FULL.repeat(full) + STATUSLINE_BAR_EMPTY.repeat(STATUSLINE_BAR_CELLS - full)
  );
}

function paint(text: string, pct: number, color: boolean): string {
  if (!color) return text;
  const tone =
    pct >= STATUSLINE_DANGER_PCT
      ? STATUSLINE_ANSI.red
      : pct >= STATUSLINE_WARN_PCT
        ? STATUSLINE_ANSI.yellow
        : STATUSLINE_ANSI.green;
  return `${tone}${text}${STATUSLINE_ANSI.reset}`;
}

/** Local time of a reset, or undefined when it is not a date we can print
 *  (out-of-range value, unknown zone). */
function resetLabel(epochSeconds: number, withDay: boolean, timeZone?: string): string | undefined {
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    const time = new Intl.DateTimeFormat(STATUSLINE_LOCALE, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(date);
    if (!withDay) return time;
    const day = new Intl.DateTimeFormat(STATUSLINE_LOCALE, { weekday: 'short', timeZone })
      .format(date)
      .replace(/\.$/, '');
    return `${day} ${time}`;
  } catch {
    return undefined;
  }
}

function limitSegment(
  label: string,
  limit: LimitWindow | undefined,
  withDay: boolean,
  opts: FormatOptions,
): string {
  if (!limit) return `${label} ${STATUSLINE_UNKNOWN}`;
  let text = `${label} ${bar(limit.usedPct)} ${Math.round(limit.usedPct)}%`;
  const reset =
    limit.resetsAt === undefined ? undefined : resetLabel(limit.resetsAt, withDay, opts.timeZone);
  if (reset) text += ` ↺${reset}`;
  return paint(text, limit.usedPct, opts.color);
}

/**
 * The line under the prompt, e.g.
 * `Opus 5.5 xhigh · ctx 34% · 5h ▰▰▰▱▱ 62% ↺21:40 · 7d ▰▱▱▱▱ 18% ↺lun 09:00 · $1.23`.
 * `now` is accepted for future relative times and keeps the signature testable.
 */
export function formatStatusLine(input: StatusInput, _now: number, opts: FormatOptions): string {
  const name = input.model?.displayName ?? input.model?.id ?? STATUSLINE_FALLBACK_NAME;
  const parts = [input.effort ? `${name} ${input.effort}` : name];
  if (input.contextUsedPct !== undefined) {
    parts.push(`ctx ${Math.round(input.contextUsedPct)}%`);
  }
  parts.push(limitSegment('5h', input.fiveHour, false, opts));
  parts.push(limitSegment('7d', input.sevenDay, true, opts));
  if (input.costUsd !== undefined) parts.push(`$${input.costUsd.toFixed(2)}`);
  return parts.join(STATUSLINE_SEPARATOR);
}

/** Per-session snapshot for Nakama. Never carries the transcript path. */
export function toSessionSnapshot(input: StatusInput, now: number): SessionSnapshot | null {
  if (!input.sessionId) return null;
  return {
    v: 1,
    sessionId: input.sessionId,
    updatedAt: now,
    model: input.model,
    sessionName: input.sessionName,
    effort: input.effort,
    thinkingEnabled: input.thinkingEnabled,
    fastMode: input.fastMode,
    promptCache: input.promptCache,
    cwd: input.cwd,
    contextUsedPct: input.contextUsedPct,
    contextWindowSize: input.contextWindowSize,
    costUsd: input.costUsd,
    durationMs: input.durationMs,
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    fiveHour: input.fiveHour,
    sevenDay: input.sevenDay,
  };
}

/** The plan limits are account-wide: the reading of any session counts. */
export function toUsageSnapshot(input: StatusInput, now: number): UsageSnapshot | null {
  if (!input.fiveHour && !input.sevenDay) return null;
  return {
    v: 1,
    updatedAt: now,
    sessionId: input.sessionId,
    fiveHour: input.fiveHour,
    sevenDay: input.sevenDay,
  };
}

/** Pick the truer of two readings of one window. An idle console re-sends
 *  its cached reading, so "last write wins" could move usage backwards: within
 *  one window usage only grows, and a reading from an ended window is stale. */
function mergeWindow(prev?: LimitWindow, next?: LimitWindow): LimitWindow | undefined {
  if (!next) return prev;
  if (!prev || prev.resetsAt === undefined || next.resetsAt === undefined) return next;
  const delta = next.resetsAt - prev.resetsAt;
  if (Math.abs(delta) <= STATUSLINE_SAME_WINDOW_SLACK_S) {
    return next.usedPct >= prev.usedPct ? next : prev;
  }
  return delta > 0 ? next : prev;
}

/** Fold a new reading into the stored usage.json. Read-modify-write without a
 *  lock: two consoles racing can lose one update, never corrupt the file. */
export function mergeUsage(prev: UsageSnapshot | null, next: UsageSnapshot): UsageSnapshot {
  return {
    v: 1,
    updatedAt: next.updatedAt,
    sessionId: next.sessionId,
    fiveHour: mergeWindow(prev?.fiveHour, next.fiveHour),
    sevenDay: mergeWindow(prev?.sevenDay, next.sevenDay),
  };
}

/** Key names and value types only, so a schema change in Claude Code shows up
 *  without ever writing a value (paths, ids, costs) to disk. Bounded in depth
 *  and width, since some keys may be dynamic names. */
export function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (!isObject(value)) return typeof value;
  if (depth >= STATUSLINE_SHAPE_MAX_DEPTH) return 'object';
  const entries = Object.entries(value);
  const out: Json = {};
  for (const [key, child] of entries.slice(0, STATUSLINE_SHAPE_MAX_KEYS)) {
    out[key] = describeShape(child, depth + 1);
  }
  if (entries.length > STATUSLINE_SHAPE_MAX_KEYS) {
    out['…'] = `${entries.length - STATUSLINE_SHAPE_MAX_KEYS} more`;
  }
  return out;
}
