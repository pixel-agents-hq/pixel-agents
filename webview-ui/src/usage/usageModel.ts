/**
 * The server room's usage meter as pure rules (DOM-free, Node-tested): the
 * client state the two server messages build, what each of the display's rows
 * says, its colour, its tooltip, and where on the map the display hangs.
 * UsageMeterOverlay.tsx draws them; usageStore.ts holds the state.
 */

import type {
  SubscriptionUsage,
  UsageMeterState,
  UsageMeterStatus,
  UsageWindow,
} from '../../../core/src/messages.js';
import {
  USAGE_METER_HEIGHT_SPRITE_PX,
  USAGE_METER_HIGH_PERCENT,
  USAGE_METER_MAX_WIDTH_TILES,
  USAGE_METER_WARN_PERCENT,
} from '../constants.js';
import { formatClock, formatDuration } from '../inbox/inboxModel.js';
import { TILE_SIZE } from '../office/types.js';

export interface UsageMeterClientState {
  /** settings.json's status line, as the server last derived it; null until
   *  it says (a server too old to have the meter never does). */
  meter: UsageMeterState | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** When the last report arrived (epoch ms); absent = no report yet. */
  updatedAt?: number;
}

export const INITIAL_USAGE_STATE: UsageMeterClientState = { meter: null };

export type UsageMessage = SubscriptionUsage | UsageMeterStatus;

export function isUsageMessage(msg: unknown): msg is UsageMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === 'subscriptionUsage' || type === 'usageMeterStatus';
}

export function reduceUsageMessage(
  state: UsageMeterClientState,
  msg: UsageMessage,
): UsageMeterClientState {
  if (msg.type === 'usageMeterStatus') return { ...state, meter: msg.state };
  // A usage message is the whole picture: a window it omits has reset.
  return {
    meter: state.meter,
    fiveHour: msg.fiveHour,
    sevenDay: msg.sevenDay,
    updatedAt: msg.updatedAt,
  };
}

// ── Rows ─────────────────────────────────────────────────────

export type UsageLevel = 'ok' | 'warn' | 'high';

export function usageLevel(usedPercentage: number): UsageLevel {
  if (usedPercentage >= USAGE_METER_HIGH_PERCENT) return 'high';
  if (usedPercentage >= USAGE_METER_WARN_PERCENT) return 'warn';
  return 'ok';
}

export interface UsageRow {
  /** "5H" / "7D". */
  label: string;
  /** 0-100, for the bar's fill; 0 with no window. */
  percent: number;
  level: UsageLevel;
  /** "62% · 6:30 pm", or "—" when the window has no usage yet. */
  text: string;
  /** Tooltip line: "Session (5-hour): 62% used, resets 6:30 pm (in 1h 12m)". */
  detail: string;
}

/** "23%" -- rounded down so 99.6 never reads as full. */
function percentText(used: number): string {
  return `${Math.floor(used)}%`;
}

function row(label: string, name: string, window: UsageWindow | undefined, now: number): UsageRow {
  if (!window || window.resetsAt <= now) {
    return {
      label,
      percent: 0,
      level: 'ok',
      text: '—',
      detail: `${name}: no usage reported in the current window yet`,
    };
  }
  const pct = percentText(window.usedPercentage);
  const clock = formatClock(window.resetsAt, now);
  return {
    label,
    percent: window.usedPercentage,
    level: usageLevel(window.usedPercentage),
    text: `${pct} · ${clock}`,
    detail: `${name}: ${pct} used, resets ${clock} (in ${formatDuration(window.resetsAt - now)})`,
  };
}

/** The display's two rows: the 5-hour session window, then the weekly cap. */
export function usageRows(state: UsageMeterClientState, now: number): UsageRow[] {
  return [
    row('5H', 'Session (5-hour)', state.fiveHour, now),
    row('7D', 'Weekly (7-day)', state.sevenDay, now),
  ];
}

/**
 * What the display shows instead of bars, or null when it shows the bars:
 * the meter is off, refused, or on but waiting for Claude Code's first report.
 * Off, it says how to turn it on from where the viewer is: a board that may
 * change settings turns it on with a click on the display itself (Settings is
 * out of reach in TV mode); a read-only one needs the private link.
 */
export function usagePlaceholder(state: UsageMeterClientState, readOnly = false): string | null {
  switch (state.meter) {
    case 'on':
      return state.updatedAt === undefined ? 'USAGE · waiting for Claude Code' : null;
    case 'foreign':
      return 'USAGE · your own status line is set';
    case 'unreadable':
      return 'USAGE · settings.json unreadable';
    case 'off':
      return readOnly
        ? 'USAGE · off (turn on from the private link)'
        : 'USAGE · off · click to turn on';
    default:
      return null;
  }
}

/** The whole tooltip: one line per window, then when it was reported. */
export function usageTooltip(state: UsageMeterClientState, now: number): string {
  const lines = usageRows(state, now).map((r) => r.detail);
  if (state.updatedAt !== undefined) {
    lines.push(`Updated ${formatClock(state.updatedAt, now)}`);
  }
  return lines.join('\n');
}

// ── Placement ────────────────────────────────────────────────

/** A rectangle in world (sprite) px. */
export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the display hangs: on the wall just above the server racks, from the
 * room's left edge across its width (at most USAGE_METER_MAX_WIDTH_TILES).
 * Without racks it sits at the top of the room. Null when the layout has no
 * Server room.
 *
 * `rackTiles` are `col,row` keys (OfficeZones.rackTiles).
 */
export function usageMeterRect(
  serverTiles: ReadonlyArray<{ col: number; row: number }>,
  rackTiles: readonly string[],
): WorldRect | null {
  if (serverTiles.length === 0) return null;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let topRow = Infinity;
  for (const t of serverTiles) {
    minCol = Math.min(minCol, t.col);
    maxCol = Math.max(maxCol, t.col);
    topRow = Math.min(topRow, t.row);
  }
  for (const key of rackTiles) {
    const row = Number(key.split(',')[1]);
    if (Number.isFinite(row)) topRow = Math.min(topRow, row);
  }
  const widthTiles = Math.min(maxCol - minCol + 1, USAGE_METER_MAX_WIDTH_TILES);
  return {
    x: minCol * TILE_SIZE,
    y: topRow * TILE_SIZE - USAGE_METER_HEIGHT_SPRITE_PX,
    w: widthTiles * TILE_SIZE,
    h: USAGE_METER_HEIGHT_SPRITE_PX,
  };
}
