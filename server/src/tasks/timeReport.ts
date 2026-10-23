/**
 * TimeReport: time per repo over a date range (docs/office/DESIGN.md, phase G,
 * "Time per repo + CSV") -- what the Tasks board's Time tab shows and exports.
 *
 * One row per repo per day, from two per-day sources that each answer for
 * today from memory and for any other day from their file:
 *  - the task log (taskLedger.ts): a day's tasks grouped by repo give the
 *    active time and the task, PR and push counts;
 *  - the token meter (signals/tokenMeter.ts): a day's API responses grouped
 *    by the repo they were attributed to give the tokens and the list-price
 *    estimate (signals/pricing.ts -- a model without a price marks the row's
 *    estimate partial, never a guess).
 * A row carries token fields only when some response of that day was
 * attributed to the repo: work on another machine, a transcript this server
 * never read, or a token file from before attribution existed shows "—", not
 * zero. Responses with no repo at all are summed per day as `unattributed`,
 * so the day's total spend is still there.
 *
 * The report has no state of its own. timeReportRange validates what a client
 * asks for: two real dates, from not after to, at most TIME_REPORT_MAX_DAYS;
 * anything else gets no answer (clientMessageHandler.ts).
 */

import type {
  Task,
  TimeReport,
  TimeReportRow,
  TimeReportUnattributed,
} from '../../../core/src/messages.js';
import { TIME_REPORT_MAX_DAYS } from '../constants.js';
import { localDateKey } from '../progress/progressTracker.js';
import { messageCostUsd } from '../signals/pricing.js';
import type { UsageEntry } from '../signals/tokenMeter.js';
import { isDateKey } from './taskLedger.js';

export interface TimeReportRange {
  from: string;
  to: string;
}

/** Where a day's figures come from (TaskLedger.tasksFor, SignalsHub.tokenUsageFor). */
export interface TimeReportSources {
  tasksFor: (date: string) => Task[];
  usageFor: (date: string) => UsageEntry[];
}

/** Tokens attributed to one repo (or to none) on one day, being summed. */
interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  priced: boolean;
  unpriced: boolean;
}

/**
 * The range a requestTimeReport names, or undefined when it names nothing a
 * report can be built for: a malformed or impossible date, `from` after `to`,
 * or more than TIME_REPORT_MAX_DAYS days.
 */
export function timeReportRange(from: unknown, to: unknown): TimeReportRange | undefined {
  if (!isDateKey(from) || !isDateKey(to) || from > to) return undefined;
  if (datesBetween(from, to).length > TIME_REPORT_MAX_DAYS) return undefined;
  return { from, to };
}

/** Every local date from `from` to `to`, both included, in order. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const [year, month, day] = from.split('-').map(Number);
  for (let offset = 0; ; offset++) {
    const date = localDateKey(new Date(year, month - 1, day + offset).getTime());
    if (date > to) return dates;
    dates.push(date);
  }
}

/** The report for a validated range. */
export function buildTimeReport(range: TimeReportRange, sources: TimeReportSources): TimeReport {
  const rows: TimeReportRow[] = [];
  const unattributed: TimeReportUnattributed[] = [];
  for (const date of datesBetween(range.from, range.to)) {
    const byRepo = new Map<string, TimeReportRow>();
    const rowFor = (repo: string): TimeReportRow => {
      let row = byRepo.get(repo);
      if (!row) {
        row = { date, repo, activeMs: 0, tasks: 0, prs: 0, pushes: 0 };
        byRepo.set(repo, row);
      }
      return row;
    };

    for (const task of sources.tasksFor(date)) {
      const row = rowFor(task.repo);
      row.activeMs += task.activeMs;
      row.tasks++;
      row.prs += task.prs.length;
      row.pushes += task.pushes;
    }

    const tokensByRepo = new Map<string, TokenSums>();
    let loose: TokenSums | undefined;
    for (const entry of sources.usageFor(date)) {
      if (entry.repo === undefined) {
        add((loose ??= emptySums()), entry);
        continue;
      }
      let sums = tokensByRepo.get(entry.repo);
      if (!sums) tokensByRepo.set(entry.repo, (sums = emptySums()));
      add(sums, entry);
    }
    for (const [repo, sums] of tokensByRepo) Object.assign(rowFor(repo), tokenFields(sums));
    if (loose) unattributed.push({ date, ...tokenFields(loose) });

    rows.push(...[...byRepo.values()].sort((a, b) => byRepoName(a.repo, b.repo)));
  }
  return { type: 'timeReport', from: range.from, to: range.to, rows, unattributed };
}

// ── Helpers ──────────────────────────────────────────────────

/** Plain code-point order: stable across locales, so a row never moves. */
function byRepoName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptySums(): TokenSums {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd: 0,
    priced: false,
    unpriced: false,
  };
}

function add(sums: TokenSums, entry: UsageEntry): void {
  const { tokens } = entry;
  sums.input += tokens.input;
  sums.output += tokens.output;
  sums.cacheRead += tokens.cacheRead;
  sums.cacheWrite += tokens.cacheWrite5m + tokens.cacheWrite1h;
  const cost = messageCostUsd(entry.model, tokens);
  if (cost === undefined) {
    sums.unpriced = true;
  } else {
    sums.priced = true;
    sums.usd += cost;
  }
}

/** The wire fields of a sum: the four counts, and the estimate when anything was priced. */
function tokenFields(sums: TokenSums): Omit<TimeReportUnattributed, 'date'> {
  return {
    input: sums.input,
    output: sums.output,
    cacheRead: sums.cacheRead,
    cacheWrite: sums.cacheWrite,
    ...(sums.priced ? { estimatedUsd: round4(sums.usd) } : {}),
    ...(sums.priced && sums.unpriced ? { partialEstimate: true } : {}),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
