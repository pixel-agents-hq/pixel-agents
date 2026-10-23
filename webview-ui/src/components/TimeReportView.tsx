import { useEffect, useState } from 'react';

import { formatHours } from '../progress/progressFormat.js';
import { formatTokenCount, formatUsd } from '../signals/signalFormat.js';
import { useTasksState } from '../tasks/tasksStore.js';
import {
  buildTimeTable,
  csvFileName,
  dayLabel,
  rangeKey,
  rangeLabel,
  type RangeMode,
  rangeOf,
  shiftAnchor,
  type TimeFocus,
  timeReportCsv,
  type TimeTable,
  type TimeTableRow,
  UNATTRIBUTED_REPO,
} from '../tasks/timeReport.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

/** A range with today in it is still moving (live tasks, live tokens): re-ask this often. */
const REFRESH_MS = 30_000;

const ESTIMATE_NOTE = 'Estimated at API list prices; a subscription is not billed per token.';

const MODES: ReadonlyArray<{ mode: RangeMode; label: string }> = [
  { mode: 'week', label: 'Week' },
  { mode: 'month', label: 'Month' },
];

/** Hand the viewer a file to save: a Blob behind an <a download> click. */
function downloadTextFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked a moment later: some browsers start the download after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** '—' for a repo nothing was attributed to; '~$3.40', '~$3.40+' when part of it had no price. */
function usdCell(row: TimeTableRow): string {
  if (row.estimatedUsd === undefined) return '—';
  return `~${formatUsd(row.estimatedUsd)}${row.partialEstimate ? '+' : ''}`;
}

function Cells({ row }: { row: TimeTableRow }) {
  const num = 'py-3 pl-6 text-right tabular-nums whitespace-nowrap';
  const dash = 'No tokens attributed here (another machine, or recorded before attribution)';
  return (
    <>
      <td className={num}>{formatHours(row.activeMs)}</td>
      <td className={num}>{row.tasks}</td>
      <td className={num}>{row.prs}</td>
      <td className={num}>{row.pushes}</td>
      <td className={num} title={row.tokens === undefined ? dash : undefined}>
        {row.tokens === undefined ? '—' : formatTokenCount(row.tokens)}
      </td>
      <td className={num} title={row.estimatedUsd === undefined ? dash : ESTIMATE_NOTE}>
        {usdCell(row)}
      </td>
    </>
  );
}

function Table({
  table,
  compact,
  onPick,
}: {
  table: TimeTable;
  compact: boolean;
  onPick: (key: string) => void;
}) {
  const head = 'py-2 pl-6 text-right font-normal whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table
        className={`w-full border-collapse ${compact ? 'text-2xs' : 'text-sm'}`}
        data-testid="time-table"
      >
        <thead>
          <tr className="text-text-muted text-2xs">
            <th className="py-2 text-left font-normal">{table.by === 'repo' ? 'Repo' : 'Day'}</th>
            <th className={head}>Active</th>
            <th className={head}>Tasks</th>
            <th className={head}>PRs</th>
            <th className={head}>Pushes</th>
            <th className={head}>Tokens</th>
            <th className={head} title={ESTIMATE_NOTE}>
              est. $
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr
              key={row.key}
              role="button"
              tabIndex={0}
              onClick={() => onPick(row.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick(row.key);
                }
              }}
              title={table.by === 'repo' ? `${row.key}: by day` : `${row.label}: by repo`}
              className="border-t-2 border-border cursor-pointer hover:bg-btn-hover focus:bg-btn-hover outline-none"
              data-testid="time-row"
            >
              <td className="py-3 break-all">{row.label}</td>
              <Cells row={row} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border text-accent-bright" data-testid="time-total">
            <td className="py-3">{table.total.label}</td>
            <Cells row={table.total} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

interface TimeReportViewProps {
  /** Today's date key: where the view starts, and the newest day it may reach. */
  today: string;
  /** Phones: smaller text; the table scrolls sideways. */
  compact: boolean;
}

/**
 * The Tasks board's Time tab (docs/office/DESIGN.md, phase G): a week or a
 * month of time per repo -- active hours, tasks, PRs, pushes, tokens and the
 * estimated spend -- as one table, each row a repo. A repo row drills into
 * its days, a day row into that day's repos. The CSV export is built here
 * from the same report, one line per repo per day. Read-only clients may view
 * and export: the request is a read (clientMessageHandler.ts).
 */
export function TimeReportView({ today, compact }: TimeReportViewProps) {
  const { timeReports } = useTasksState();
  const [mode, setMode] = useState<RangeMode>('week');
  const [anchor, setAnchor] = useState(today);
  const [focus, setFocus] = useState<TimeFocus>(null);
  const range = rangeOf(mode, anchor);
  const report = timeReports[rangeKey(range)];
  const includesToday = range.from <= today && today <= range.to;

  useEffect(() => {
    const ask = () => transport.send({ type: 'requestTimeReport', from: range.from, to: range.to });
    ask();
    if (!includesToday) return;
    const id = window.setInterval(ask, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [range.from, range.to, includesToday]);

  // A repo stays in focus across ranges ("this repo, last week"); a day belongs to one.
  const shift = (by: -1 | 1) => {
    setAnchor(shiftAnchor(anchor, mode, by));
    setFocus((f) => (f?.kind === 'day' ? null : f));
  };
  const pickMode = (next: RangeMode) => {
    setMode(next);
    setFocus((f) => (f?.kind === 'day' ? null : f));
  };
  const table = report && buildTimeTable(report, focus);
  const pickRow = (key: string) => {
    setFocus(table?.by === 'repo' ? { kind: 'repo', repo: key } : { kind: 'day', date: key });
  };
  const exportCsv = () => {
    if (report)
      downloadTextFile(csvFileName(range), timeReportCsv(report), 'text/csv;charset=utf-8');
  };

  let body;
  if (!table) {
    body = <div className="text-sm text-text-muted">Loading…</div>;
  } else if (table.rows.length === 0 && !table.unattributed) {
    body = (
      <div className="text-sm text-text-muted" data-testid="time-empty">
        {focus ? 'Nothing here.' : 'Nothing worked on in this range.'}
      </div>
    );
  } else {
    body = <Table table={table} compact={compact} onPick={pickRow} />;
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-8 text-sm">
        <div className="flex gap-4" role="group" aria-label="Range">
          {MODES.map(({ mode: m, label }) => (
            <Button
              key={m}
              size="sm"
              aria-pressed={mode === m}
              variant={mode === m ? 'active' : 'default'}
              onClick={() => pickMode(m)}
              data-testid={`time-mode-${m}`}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Button
            size="sm"
            onClick={() => shift(-1)}
            aria-label={`Previous ${mode}`}
            data-testid="time-prev"
          >
            ◀
          </Button>
          <span className="px-4 whitespace-nowrap" data-testid="time-range">
            {rangeLabel(range, mode)}
          </span>
          <Button
            size="sm"
            variant={range.to < today ? 'default' : 'disabled'}
            disabled={range.to >= today}
            onClick={() => shift(1)}
            aria-label={`Next ${mode}`}
            data-testid="time-next"
          >
            ▶
          </Button>
        </div>
        <Button
          size="sm"
          variant={report ? 'accent' : 'disabled'}
          disabled={!report}
          onClick={exportCsv}
          title="Download this range as CSV: one row per repo per day"
          data-testid="time-csv"
        >
          ⬇ CSV
        </Button>
      </div>
      {focus && (
        <div className="flex items-center gap-8 text-sm">
          <Button size="sm" variant="ghost" onClick={() => setFocus(null)} data-testid="time-back">
            ← {focus.kind === 'repo' ? 'All repos' : 'All days'}
          </Button>
          <span className="text-accent-bright break-all">
            {focus.kind === 'repo' ? focus.repo : dayLabel(focus.date)}
          </span>
        </div>
      )}
      {body}
      {table?.unattributed && (
        <div className="text-2xs text-text-muted leading-snug" data-testid="time-unattributed">
          Tokens on {table.unattributed.days} {table.unattributed.days === 1 ? 'day' : 'days'} here
          were recorded before they were split by repo:{' '}
          {formatTokenCount(table.unattributed.tokens)} tok
          {table.unattributed.estimatedUsd !== undefined &&
            ` · ~${formatUsd(table.unattributed.estimatedUsd)}${table.unattributed.partialEstimate ? '+' : ''} est.`}{' '}
          count in the total only (the CSV lists them as {UNATTRIBUTED_REPO}).
        </div>
      )}
      {table && (table.rows.length > 0 || table.unattributed) && (
        <div className="text-2xs text-text-muted leading-snug">{ESTIMATE_NOTE}</div>
      )}
    </div>
  );
}
