/**
 * The Time tab's pure half (docs/office/DESIGN.md, phase G): the week or
 * month a view covers and how it moves, the per-repo table and its two
 * drill-downs, the CSV text, and the store's handling of a timeReport.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { TimeReport, TimeReportRow } from '../../core/src/messages.js';
import { initialTasksState, isTasksMessage, reduceTasksMessage } from '../src/tasks/tasksStore.js';
import {
  buildTimeTable,
  CSV_COLUMNS,
  csvField,
  csvFileName,
  dayLabel,
  monthOf,
  rangeKey,
  rangeLabel,
  shiftAnchor,
  timeReportCsv,
  UNATTRIBUTED_REPO,
  weekOf,
} from '../src/tasks/timeReport.js';

const NOW = new Date(2026, 9, 18, 15, 0, 0).getTime(); // Sunday 2026-10-18 15:00 local
const H = 3_600_000;

function row(date: string, repo: string, over: Partial<TimeReportRow> = {}): TimeReportRow {
  return { date, repo, activeMs: 0, tasks: 0, prs: 0, pushes: 0, ...over };
}

const tokens = (input: number, estimatedUsd?: number): Partial<TimeReportRow> => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
});

function report(rows: TimeReportRow[], unattributed: TimeReport['unattributed'] = []): TimeReport {
  return { type: 'timeReport', from: '2026-10-12', to: '2026-10-18', rows, unattributed };
}

describe('ranges', () => {
  it('a week runs Monday to Sunday around any of its days', () => {
    expect(weekOf('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // a Sunday
    expect(weekOf('2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // a Monday
    expect(weekOf('2026-10-15')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    // Across a month end and a year end.
    expect(weekOf('2026-10-01')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(weekOf('2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
  });

  it('a month runs first to last day, leap years included', () => {
    expect(monthOf('2026-10-18')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthOf('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('shifts by a week or a month, landing on the first day of the new range', () => {
    expect(shiftAnchor('2026-10-18', 'week', -1)).toBe('2026-10-05');
    expect(shiftAnchor('2026-10-18', 'week', 1)).toBe('2026-10-19');
    expect(shiftAnchor('2026-10-31', 'month', 1)).toBe('2026-11-01');
    expect(shiftAnchor('2026-01-31', 'month', -1)).toBe('2025-12-01');
    expect(monthOf(shiftAnchor('2026-01-31', 'month', 1))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('labels: the store key, the range and a day', () => {
    expect(rangeKey({ from: '2026-10-12', to: '2026-10-18' })).toBe('2026-10-12..2026-10-18');
    expect(rangeLabel({ from: '2026-10-12', to: '2026-10-18' }, 'week')).toBe('12–18 Oct 2026');
    expect(rangeLabel({ from: '2026-09-28', to: '2026-10-04' }, 'week')).toBe(
      '28 Sep – 4 Oct 2026',
    );
    expect(rangeLabel({ from: '2025-12-29', to: '2026-01-04' }, 'week')).toBe(
      '29 Dec 2025 – 4 Jan 2026',
    );
    expect(rangeLabel({ from: '2026-10-01', to: '2026-10-31' }, 'month')).toBe('October 2026');
    expect(dayLabel('2026-10-12')).toBe('Mon 12 Oct');
  });
});

describe('buildTimeTable', () => {
  const r = report(
    [
      row('2026-10-12', 'web', {
        activeMs: 2 * H,
        tasks: 2,
        prs: 1,
        pushes: 3,
        ...tokens(1000, 1),
      }),
      row('2026-10-12', 'api', { activeMs: 0.5 * H, tasks: 1 }),
      row('2026-10-13', 'web', { activeMs: 1 * H, tasks: 1, pushes: 1, ...tokens(500, 0.5) }),
      row('2026-10-13', 'docs', { activeMs: 3 * H, tasks: 1, ...tokens(50, 0.01) }),
    ],
    [{ date: '2026-10-14', input: 200, output: 0, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0.2 }],
  );

  it('one row per repo over the range, busiest first (ties by name), tokens "—" where none were attributed', () => {
    const t = buildTimeTable(r, null);
    expect(t.by).toBe('repo');
    // docs and web both have 3 h: docs first by name.
    expect(t.rows).toEqual([
      {
        key: 'docs',
        label: 'docs',
        activeMs: 3 * H,
        tasks: 1,
        prs: 0,
        pushes: 0,
        tokens: 50,
        estimatedUsd: 0.01,
      },
      {
        key: 'web',
        label: 'web',
        activeMs: 3 * H,
        tasks: 3,
        prs: 1,
        pushes: 4,
        tokens: 1500,
        estimatedUsd: 1.5,
      },
      { key: 'api', label: 'api', activeMs: 0.5 * H, tasks: 1, prs: 0, pushes: 0 },
    ]);
    // The total carries the unattributed day's tokens, and says so.
    expect(t.total).toMatchObject({
      key: 'total',
      label: 'Total',
      activeMs: 6.5 * H,
      tasks: 5,
      prs: 1,
      pushes: 4,
      tokens: 1750,
    });
    expect(t.total.estimatedUsd).toBeCloseTo(1.71);
    expect(t.unattributed).toEqual({ days: 1, tokens: 200, estimatedUsd: 0.2 });
  });

  it('drills into a repo: its days, oldest first, nothing unattributed', () => {
    const t = buildTimeTable(r, { kind: 'repo', repo: 'web' });
    expect(t.by).toBe('day');
    expect(t.rows.map((x) => [x.key, x.label, x.activeMs / H, x.tokens])).toEqual([
      ['2026-10-12', 'Mon 12 Oct', 2, 1000],
      ['2026-10-13', 'Tue 13 Oct', 1, 500],
    ]);
    expect(t.total).toMatchObject({ activeMs: 3 * H, tasks: 3, tokens: 1500, estimatedUsd: 1.5 });
    expect(t.unattributed).toBeUndefined();
  });

  it('drills into a day: its repos, with only that day’s unattributed tokens', () => {
    const t = buildTimeTable(r, { kind: 'day', date: '2026-10-13' });
    expect(t.by).toBe('repo');
    expect(t.rows.map((x) => x.key)).toEqual(['docs', 'web']);
    expect(t.unattributed).toBeUndefined();
    const u = buildTimeTable(r, { kind: 'day', date: '2026-10-14' });
    expect(u.rows).toEqual([]);
    expect(u.total.tokens).toBe(200);
    expect(u.unattributed).toEqual({ days: 1, tokens: 200, estimatedUsd: 0.2 });
  });

  it('marks a total partial when any row is, and leaves the estimate out when none has one', () => {
    const t = buildTimeTable(
      report([
        row('2026-10-12', 'a', { ...tokens(10, 0.1), partialEstimate: true }),
        row('2026-10-12', 'b', { ...tokens(10, 0.2) }),
      ]),
      null,
    );
    expect(t.total).toMatchObject({ tokens: 20, partialEstimate: true });
    expect(t.total.estimatedUsd).toBeCloseTo(0.3);
    const none = buildTimeTable(report([row('2026-10-12', 'a', { activeMs: H, tasks: 1 })]), null);
    expect(none.total.tokens).toBeUndefined();
    expect(none.total.estimatedUsd).toBeUndefined();
    expect(none.rows[0]).not.toHaveProperty('tokens');
  });

  it('never mutates the report', () => {
    const rows = [row('2026-10-12', 'web', { activeMs: H, tasks: 1 })];
    const r2 = report(rows);
    buildTimeTable(r2, null);
    buildTimeTable(r2, { kind: 'repo', repo: 'web' });
    expect(r2.rows).toEqual([row('2026-10-12', 'web', { activeMs: H, tasks: 1 })]);
  });
});

describe('CSV', () => {
  it('quotes fields with commas, quotes or line breaks; an absent number is empty', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(42)).toBe('42');
    expect(csvField(undefined)).toBe('');
  });

  it('one row per repo per day in the given columns, hours and dollars as decimals', () => {
    const csv = timeReportCsv(
      report(
        [
          row('2026-10-12', 'web, "the" site', {
            activeMs: 1.5 * H,
            tasks: 2,
            prs: 1,
            pushes: 3,
            input: 1000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 4,
            estimatedUsd: 1.23456,
          }),
          row('2026-10-13', 'api', { activeMs: 0.25 * H, tasks: 1 }),
        ],
        [
          {
            date: '2026-10-14',
            input: 7,
            output: 8,
            cacheRead: 9,
            cacheWrite: 10,
            estimatedUsd: 0.5,
          },
        ],
      ),
    );
    expect(csv.split('\r\n')).toEqual([
      CSV_COLUMNS.join(','),
      '2026-10-12,"web, ""the"" site",1.50,2,1,3,1000,200,30,4,1.2346',
      '2026-10-13,api,0.25,1,0,0,,,,,',
      `2026-10-14,${UNATTRIBUTED_REPO},0.00,0,0,0,7,8,9,10,0.5000`,
      '',
    ]);
    expect(CSV_COLUMNS).toEqual([
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
    ]);
  });

  it('names the file after the range', () => {
    expect(csvFileName({ from: '2026-10-12', to: '2026-10-18' })).toBe(
      'time-per-repo-2026-10-12-to-2026-10-18.csv',
    );
  });
});

describe('the store', () => {
  it('keeps a timeReport by its range and marks the feature supported', () => {
    const msg = report([row('2026-10-12', 'web', { activeMs: H, tasks: 1 })]);
    expect(isTasksMessage(msg)).toBe(true);
    const s = reduceTasksMessage(initialTasksState(NOW), msg, NOW);
    expect(s.supported).toBe(true);
    expect(s.timeReports['2026-10-12..2026-10-18']).toEqual(msg);
    // A malformed reply (no arrays) still lands as an empty report.
    const odd = {
      type: 'timeReport',
      from: '2026-10-05',
      to: '2026-10-11',
    } as unknown as TimeReport;
    expect(reduceTasksMessage(s, odd, NOW).timeReports['2026-10-05..2026-10-11']).toEqual({
      ...odd,
      rows: [],
      unattributed: [],
    });
  });
});
