/**
 * The Time tab's pure half (docs/office/DESIGN.md, phase G, "Time per repo +
 * CSV"): the week or month a view covers, the table built from a timeReport
 * (per repo, or drilled into one repo's days or one day's repos), and the CSV
 * text. DOM-free, so it unit-tests in the Node runner; the download itself is
 * TimeReportView's.
 */

import type { TimeReport, TimeReportRow } from '../../../core/src/messages.js';
import { localDateKey } from './taskBoard.js';

export type RangeMode = 'week' | 'month';

export interface DateRange {
  /** Both 'YYYY-MM-DD', inclusive. */
  from: string;
  to: string;
}

/** What the table is narrowed to: one repo's days, one day's repos, or nothing. */
export type TimeFocus = { kind: 'repo'; repo: string } | { kind: 'day'; date: string } | null;

export interface TimeTableRow {
  /** The repo, or the date when the rows are days. */
  key: string;
  label: string;
  activeMs: number;
  tasks: number;
  prs: number;
  pushes: number;
  /** Every token kind summed; undefined when nothing was attributed ("—"). */
  tokens?: number;
  estimatedUsd?: number;
  /** Some tokens came from a model without a price. */
  partialEstimate?: boolean;
}

export interface TimeTable {
  /** What the first column lists. */
  by: 'repo' | 'day';
  rows: TimeTableRow[];
  /** Every row summed, the unattributed tokens included. */
  total: TimeTableRow;
  /** Tokens no repo can show (days before attribution): in the total only. */
  unattributed?: { days: number; tokens: number; estimatedUsd?: number; partialEstimate?: boolean };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Ranges ────────────────────────────────────────────────────

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

/** A local date `days` after the one given (negative: before). */
function plusDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return localDateKey(new Date(y, m - 1, d + days).getTime());
}

/** Monday to Sunday around the date. */
export function weekOf(date: string): DateRange {
  const [y, m, d] = parts(date);
  const weekday = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  const from = plusDays(date, -sinceMonday);
  return { from, to: plusDays(from, 6) };
}

/** The first to the last day of the date's month. */
export function monthOf(date: string): DateRange {
  const [y, m] = parts(date);
  const lastDay = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

export function rangeOf(mode: RangeMode, anchor: string): DateRange {
  return mode === 'week' ? weekOf(anchor) : monthOf(anchor);
}

/** The anchor moved to the previous (-1) or next (+1) week or month: the
 *  first day of it, so a month step from the 31st never skips a month. */
export function shiftAnchor(anchor: string, mode: RangeMode, by: -1 | 1): string {
  if (mode === 'week') return plusDays(weekOf(anchor).from, 7 * by);
  const [y, m] = parts(anchor);
  return localDateKey(new Date(y, m - 1 + by, 1).getTime());
}

/** The store's key for a range's report. */
export function rangeKey(range: DateRange): string {
  return `${range.from}..${range.to}`;
}

/** 'October 2026' for a month; '12–18 Oct 2026', '28 Sep – 4 Oct 2026' or
 *  '29 Dec 2025 – 4 Jan 2026' for a week. */
export function rangeLabel(range: DateRange, mode: RangeMode): string {
  const [fy, fm, fd] = parts(range.from);
  const [ty, tm, td] = parts(range.to);
  if (mode === 'month') return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fy !== ty) return `${fd} ${MONTHS[fm - 1]} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fm !== tm) return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  return `${fd}–${td} ${MONTHS[fm - 1]} ${fy}`;
}

/** 'Mon 12 Oct'. */
export function dayLabel(date: string): string {
  const [y, m, d] = parts(date);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d} ${MONTHS[m - 1]}`;
}

// ── The table ─────────────────────────────────────────────────

function emptyRow(key: string, label: string): TimeTableRow {
  return { key, label, activeMs: 0, tasks: 0, prs: 0, pushes: 0 };
}

/** A report row, or an unattributed day's tokens, as a table row's figures:
 *  the four token kinds summed, undefined when absent. */
function figuresOf(
  r: Partial<TimeReportRow> & { estimatedUsd?: number; partialEstimate?: boolean },
): Omit<TimeTableRow, 'key' | 'label'> {
  return {
    activeMs: r.activeMs ?? 0,
    tasks: r.tasks ?? 0,
    prs: r.prs ?? 0,
    pushes: r.pushes ?? 0,
    ...(r.input !== undefined
      ? { tokens: r.input + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0) }
      : {}),
    ...(r.estimatedUsd !== undefined ? { estimatedUsd: r.estimatedUsd } : {}),
    ...(r.partialEstimate ? { partialEstimate: true } : {}),
  };
}

/** Add one row's figures to another's. */
function fold(into: TimeTableRow, r: Omit<TimeTableRow, 'key' | 'label'>): void {
  into.activeMs += r.activeMs;
  into.tasks += r.tasks;
  into.prs += r.prs;
  into.pushes += r.pushes;
  if (r.tokens !== undefined) into.tokens = (into.tokens ?? 0) + r.tokens;
  if (r.estimatedUsd !== undefined) into.estimatedUsd = (into.estimatedUsd ?? 0) + r.estimatedUsd;
  if (r.partialEstimate) into.partialEstimate = true;
}

/**
 * The table for a report, narrowed by `focus`: per repo over the whole range
 * (busiest first, then by name); one repo's days, oldest first; or one day's
 * repos. The total sums the rows shown, plus the tokens of the days (in view)
 * that no repo could claim -- noted as `unattributed`, so the total's tokens
 * can exceed the rows' sum and the viewer knows why. Never mutates the report.
 */
export function buildTimeTable(report: TimeReport, focus: TimeFocus): TimeTable {
  const by: TimeTable['by'] = focus?.kind === 'repo' ? 'day' : 'repo';
  const rows = new Map<string, TimeTableRow>();
  for (const r of report.rows) {
    if (focus?.kind === 'repo' && r.repo !== focus.repo) continue;
    if (focus?.kind === 'day' && r.date !== focus.date) continue;
    const key = by === 'day' ? r.date : r.repo;
    let row = rows.get(key);
    if (!row) {
      row = emptyRow(key, by === 'day' ? dayLabel(key) : key);
      rows.set(key, row);
    }
    fold(row, figuresOf(r));
  }
  const list = [...rows.values()];
  if (by === 'day') list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else list.sort((a, b) => b.activeMs - a.activeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const total = emptyRow('total', 'Total');
  for (const row of list) fold(total, row);

  let unattributed: TimeTable['unattributed'];
  // A repo's own days are exactly what attribution gave it: nothing loose applies.
  if (focus?.kind !== 'repo') {
    const loose = report.unattributed.filter((u) => focus === null || u.date === focus.date);
    if (loose.length > 0) {
      const sum = emptyRow('unattributed', '');
      for (const u of loose) fold(sum, figuresOf(u));
      fold(total, sum);
      unattributed = {
        days: loose.length,
        tokens: sum.tokens ?? 0,
        ...(sum.estimatedUsd !== undefined ? { estimatedUsd: sum.estimatedUsd } : {}),
        ...(sum.partialEstimate ? { partialEstimate: true } : {}),
      };
    }
  }
  return { by, rows: list, total, ...(unattributed ? { unattributed } : {}) };
}

// ── CSV ───────────────────────────────────────────────────────

/** The export's columns, in order. */
export const CSV_COLUMNS = [
  'date',
  'repo',
  'active_hours',
  'tasks',
  'prs',
  'pushes',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'est_usd',
] as const;

/** The repo column of a day's tokens that belong to no repo. */
export const UNATTRIBUTED_REPO = '(unattributed)';

/** One CSV field: quoted (quotes doubled) when it holds a comma, a quote or a
 *  line break; an absent number is an empty field, never 0. */
export function csvField(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The report as CSV (RFC 4180: CRLF rows, a header line): one row per repo
 * per day, hours with two decimals, the estimate with four, token fields empty
 * where nothing was attributed; then one UNATTRIBUTED_REPO row per day whose
 * tokens no repo could claim, so a spreadsheet's total matches the board's.
 */
export function timeReportCsv(report: TimeReport): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  const push = (fields: Array<string | number | undefined>) =>
    lines.push(fields.map(csvField).join(','));
  for (const r of report.rows) {
    push([
      r.date,
      r.repo,
      (r.activeMs / 3_600_000).toFixed(2),
      r.tasks,
      r.prs,
      r.pushes,
      r.input,
      r.output,
      r.cacheRead,
      r.cacheWrite,
      r.estimatedUsd === undefined ? undefined : r.estimatedUsd.toFixed(4),
    ]);
  }
  for (const u of report.unattributed) {
    push([
      u.date,
      UNATTRIBUTED_REPO,
      '0.00',
      0,
      0,
      0,
      u.input,
      u.output,
      u.cacheRead,
      u.cacheWrite,
      u.estimatedUsd === undefined ? undefined : u.estimatedUsd.toFixed(4),
    ]);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** 'time-per-repo-2026-10-12-to-2026-10-18.csv'. */
export function csvFileName(range: DateRange): string {
  return `time-per-repo-${range.from}-to-${range.to}.csv`;
}
