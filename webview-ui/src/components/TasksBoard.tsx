import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { DailyPr, Report, Task, TaskStatus } from '../../../core/src/messages.js';
import { TASKS_BOARD_WIDTH_PX, TASKS_BOARD_Z_INDEX } from '../constants.js';
import { safePrUrl } from '../progress/progressFormat.js';
import type { Block, Inline, ListBlock } from '../tasks/reportMarkdown.js';
import { parseMarkdown, safeLinkHref } from '../tasks/reportMarkdown.js';
import {
  boardSummary,
  clockTime,
  formatDuration,
  groupTasks,
  isDateKey,
  localDateKey,
  machineBadge,
  taskCounts,
  taskDurationMs,
} from '../tasks/taskBoard.js';
import type { TasksTab } from '../tasks/tasksStore.js';
import {
  closeTasksBoard,
  markReportWriting,
  openTasksBoard,
  setTasksDate,
  setTasksTab,
  useTasksState,
} from '../tasks/tasksStore.js';
import { transport } from '../transport/index.js';
import { TimeReportView } from './TimeReportView.js';
import { Button } from './ui/Button.js';

/** Open tasks' durations tick on this clock while the board is open. */
const DURATION_TICK_MS = 30_000;

const STATUS_STRIPE: Record<TaskStatus, string> = {
  in_progress: 'var(--color-status-active)',
  waiting: 'var(--color-status-permission)',
  done: 'var(--color-status-success)',
};

const TABS: ReadonlyArray<{ tab: TasksTab; label: string }> = [
  { tab: 'board', label: 'Board' },
  { tab: 'history', label: 'History' },
  { tab: 'report', label: 'Report' },
  { tab: 'time', label: 'Time' },
];

/** The "📋 Tasks" opener beside the TODAY strip (icon only on phones). */
export function TasksButton({ compact }: { compact: boolean }) {
  const { supported } = useTasksState();
  if (!supported) return null;
  return (
    <button
      type="button"
      className="shrink-0 bg-btn-bg hover:bg-btn-hover border-2 border-transparent rounded-none cursor-pointer px-6 py-0 leading-tight text-text"
      onClick={() => openTasksBoard('board')}
      title="Tasks board"
      aria-label="Open the Tasks board"
      data-testid="tasks-button"
    >
      {compact ? '📋' : '📋 Tasks'}
    </button>
  );
}

function PrLink({ pr }: { pr: DailyPr }) {
  const url = safePrUrl(pr.url);
  const body = <span className="overflow-hidden text-ellipsis">🏆 {pr.title}</span>;
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${pr.title} · ${pr.repo}`}
      className="flex min-w-0 text-text no-underline hover:text-accent-bright"
    >
      {body}
    </a>
  ) : (
    <span className="flex min-w-0" title={`${pr.title} · ${pr.repo}`}>
      {body}
    </span>
  );
}

function TaskCard({ task, now }: { task: Task; now: number }) {
  const badge = machineBadge(task);
  const counts = taskCounts(task);
  return (
    <div
      className="bg-bg-dark border-2 border-border p-6 flex flex-col gap-2 min-w-0"
      style={{ borderLeftColor: STATUS_STRIPE[task.status], borderLeftWidth: 4 }}
      data-testid="task-card"
    >
      <div className="text-sm leading-tight break-words">{task.title}</div>
      <div className="text-2xs text-text-muted flex flex-wrap gap-x-8 leading-tight">
        <span className="break-all">{task.repo}</span>
        {badge && <span>{badge}</span>}
      </div>
      <div className="text-2xs text-text-muted leading-tight">
        🕒 {clockTime(task.startedAt)} · {formatDuration(taskDurationMs(task, now))}
        {counts && ` · ${counts}`}
      </div>
      {task.prs.length > 0 && (
        <div className="text-2xs flex flex-col gap-1 leading-tight">
          {task.prs.map((pr) => (
            <PrLink key={pr.url ?? `${pr.repo}:${pr.at}`} pr={pr} />
          ))}
        </div>
      )}
    </div>
  );
}

function Kanban({ tasks, stacked, now }: { tasks: Task[]; stacked: boolean; now: number }) {
  const columns = groupTasks(tasks);
  return (
    <div className={stacked ? 'flex flex-col gap-12' : 'grid grid-cols-3 gap-8 items-start'}>
      {columns.map((col) => (
        <section key={col.status} className="flex flex-col gap-6 min-w-0">
          <h3 className="m-0 text-sm font-normal text-text-muted flex items-center gap-6">
            <span
              className="inline-block w-8 h-8"
              style={{ background: STATUS_STRIPE[col.status] }}
            />
            {col.title} ({col.tasks.length})
          </h3>
          {col.tasks.length === 0 ? (
            <div className="text-2xs text-text-muted">Nothing here.</div>
          ) : (
            col.tasks.map((t) => <TaskCard key={t.id} task={t} now={now} />)
          )}
        </section>
      ))}
    </div>
  );
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <span key={i}>{n.text}</span>;
          case 'code':
            return (
              <code key={i} className="bg-bg-dark px-2">
                {n.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={i} className="text-accent-bright font-normal">
                <InlineNodes nodes={n.children} />
              </strong>
            );
          case 'italic':
            return (
              <em key={i}>
                <InlineNodes nodes={n.children} />
              </em>
            );
          case 'link':
            return (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-bright underline"
              >
                <InlineNodes nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

/** The report's markdown, as React elements built from the parsed tree —
 *  never as HTML (see reportMarkdown.ts). */
function ReportMarkdown({ markdown }: { markdown: string }) {
  const blocks: Block[] = parseMarkdown(markdown);
  return (
    <div className="flex flex-col gap-8 text-sm leading-snug" data-testid="report-markdown">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          return (
            <div
              key={i}
              role="heading"
              aria-level={b.level}
              className={
                b.level <= 1 ? 'text-lg text-accent-bright' : 'text-base text-accent-bright'
              }
            >
              <InlineNodes nodes={b.children} />
            </div>
          );
        }
        if (b.type === 'list') return <ReportList key={i} list={b} />;
        return (
          <p key={i} className="m-0">
            <InlineNodes nodes={b.children} />
          </p>
        );
      })}
    </div>
  );
}

/** A list and the lists nested under its items. */
function ReportList({ list, nested = false }: { list: ListBlock; nested?: boolean }) {
  const items = list.items.map((item, j) => {
    const sub = list.sublists?.[j];
    return (
      <li key={j}>
        <InlineNodes nodes={item} />
        {sub && <ReportList list={sub} nested />}
      </li>
    );
  });
  const marker = list.ordered ? 'list-decimal' : nested ? 'list-[circle]' : 'list-disc';
  const className = `m-0 pl-20 ${marker} flex flex-col gap-2${nested ? ' mt-2 text-text-muted' : ''}`;
  return list.ordered ? (
    <ol className={className}>{items}</ol>
  ) : (
    <ul className={className}>{items}</ul>
  );
}

function DatePicker({ date, max }: { date: string; max: string }) {
  return (
    <label className="flex items-center gap-8 text-sm">
      <span className="text-text-muted">Day</span>
      <input
        type="date"
        value={date}
        max={max}
        onChange={(e) => {
          if (isDateKey(e.target.value)) setTasksDate(e.target.value);
        }}
        className="bg-btn-bg text-text border-2 border-border rounded-none px-6 py-1 text-sm"
        style={{ colorScheme: 'dark' }}
        data-testid="tasks-date"
      />
    </label>
  );
}

function ReportView({
  report,
  isToday,
  canWrite,
  onWrite,
}: {
  report: Report | undefined;
  isToday: boolean;
  canWrite: boolean;
  onWrite: () => void;
}) {
  const writing = report?.writing === true;
  let body: ReactNode;
  if (!report) body = <div className="text-sm text-text-muted">Loading…</div>;
  else if (report.exists && report.markdown) body = <ReportMarkdown markdown={report.markdown} />;
  else if (!writing)
    body = <div className="text-sm text-text-muted">No report for this day yet.</div>;
  return (
    <div className="flex flex-col gap-10">
      {writing && (
        <div className="text-sm text-status-permission" data-testid="report-writing">
          ✍️ writing…
        </div>
      )}
      {body}
      {report?.exists && report.details && (
        <details className="flex flex-col gap-8" data-testid="report-details">
          <summary className="cursor-pointer text-sm text-accent-bright">Details by repo</summary>
          <div className="pt-8">
            <ReportMarkdown markdown={report.details} />
          </div>
        </details>
      )}
      {report?.exists && report.notionUrl && safeLinkHref(report.notionUrl) && (
        <a
          href={safeLinkHref(report.notionUrl) ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-accent-bright"
          data-testid="report-notion-link"
        >
          Open the full status in Notion ↗
        </a>
      )}
      {report?.exists && report.generatedAt !== undefined && (
        <div className="text-2xs text-text-muted">
          {report.aiWritten ? 'Written by the Manager' : 'Template report'} ·{' '}
          {clockTime(report.generatedAt)}
        </div>
      )}
      {canWrite && isToday && (
        <div>
          <Button
            size="sm"
            variant={writing ? 'disabled' : 'accent'}
            disabled={writing}
            onClick={onWrite}
            data-testid="write-report-now"
          >
            Write report now
          </Button>
        </div>
      )}
    </div>
  );
}

interface TasksBoardProps {
  /** Phones: a full-screen sheet; desktop: a side panel on the right. */
  fullScreen: boolean;
  /** Privileged clients may spend the subscription on "Write report now". */
  canWriteReport: boolean;
}

/**
 * The Manager's Tasks board (docs/office/DESIGN.md, phase M): today's tasks
 * as a kanban (In progress / Waiting on you / Done), any past day's tasks,
 * the daily report, and time per repo (phase G, TimeReportView.tsx). Opened
 * by clicking the Manager or the "📋 Tasks" button; closed with ✕ or Esc.
 * Live: the store follows tasksSnapshot, taskUpdated, report, reportReady and
 * timeReport. Mount at App's top level (a viewport overlay — never inside the
 * mobile shell's transformed track).
 */
export function TasksBoard({ fullScreen, canWriteReport }: TasksBoardProps) {
  const s = useTasksState();
  const [now, setNow] = useState(() => Date.now());
  const today = localDateKey(now);
  const haveToday = s.tasksByDate[today] !== undefined;
  const readyCount = s.reportReadyCount[s.date] ?? 0;

  // Keep open tasks' durations (and "today") fresh while open.
  useEffect(() => {
    if (!s.open) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), DURATION_TICK_MS);
    return () => window.clearInterval(id);
  }, [s.open]);

  // Today's list comes with the connect snapshot; ask if it is missing.
  useEffect(() => {
    if (s.open && s.tab === 'board' && !haveToday) {
      transport.send({ type: 'requestTasks', date: today });
    }
  }, [s.open, s.tab, haveToday, today]);

  useEffect(() => {
    if (s.open && s.tab === 'history') transport.send({ type: 'requestTasks', date: s.date });
  }, [s.open, s.tab, s.date]);

  // Re-requested on a reportReady for the open day (readyCount bumps).
  useEffect(() => {
    if (s.open && s.tab === 'report') transport.send({ type: 'requestReport', date: s.date });
  }, [s.open, s.tab, s.date, readyCount]);

  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeTasksBoard();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [s.open]);

  if (!s.open) return null;

  const todayTasks = s.tasksByDate[today] ?? [];
  const dayTasks = s.tasksByDate[s.date];
  const stacked = fullScreen;

  // The server answers the request that follows with writing:true, and
  // later sends reportReady (which re-requests it, finished).
  const writeNow = () => {
    transport.send({ type: 'writeReportNow' });
    markReportWriting(today);
    transport.send({ type: 'requestReport', date: today });
  };

  let content: ReactNode;
  if (s.tab === 'board') {
    content = haveToday ? (
      <Kanban tasks={todayTasks} stacked={stacked} now={now} />
    ) : (
      <div className="text-sm text-text-muted">Loading…</div>
    );
  } else if (s.tab === 'history') {
    content = (
      <div className="flex flex-col gap-10">
        <DatePicker date={s.date} max={today} />
        {dayTasks === undefined ? (
          <div className="text-sm text-text-muted">Loading…</div>
        ) : dayTasks.length === 0 ? (
          <div className="text-sm text-text-muted">No tasks on this day.</div>
        ) : (
          <>
            <div className="text-2xs text-text-muted">{boardSummary(dayTasks)}</div>
            <Kanban tasks={dayTasks} stacked={stacked} now={now} />
          </>
        )}
      </div>
    );
  } else if (s.tab === 'report') {
    content = (
      <div className="flex flex-col gap-10">
        <DatePicker date={s.date} max={today} />
        <ReportView
          report={s.reports[s.date]}
          isToday={s.date === today}
          canWrite={canWriteReport}
          onWrite={writeNow}
        />
      </div>
    );
  } else {
    // The view asks for its own range (and re-asks while today is in it).
    content = <TimeReportView today={today} compact={fullScreen} />;
  }

  return (
    <div
      role="dialog"
      aria-label="Tasks board"
      className={`fixed flex flex-col bg-bg text-text ${
        fullScreen ? 'inset-0' : 'top-0 right-0 bottom-0 border-l-2 border-border shadow-pixel'
      }`}
      style={{
        zIndex: TASKS_BOARD_Z_INDEX,
        width: fullScreen ? undefined : `min(${TASKS_BOARD_WIDTH_PX}px, 100vw)`,
        paddingTop: fullScreen ? 'env(safe-area-inset-top)' : undefined,
        paddingBottom: fullScreen ? 'env(safe-area-inset-bottom)' : undefined,
      }}
      data-testid="tasks-board"
    >
      <div className="flex items-center justify-between gap-8 py-6 px-10 border-b-2 border-border">
        <div className="flex flex-col min-w-0">
          <span className="text-xl text-accent-bright leading-tight">📋 Tasks</span>
          <span className="text-2xs text-text-muted leading-tight">
            Today · {boardSummary(todayTasks)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon_lg"
          onClick={closeTasksBoard}
          aria-label="Close the Tasks board"
          title="Close (Esc)"
          data-testid="tasks-close"
        >
          ✕
        </Button>
      </div>
      <div className="flex gap-6 py-6 px-10 border-b-2 border-border" role="tablist">
        {TABS.map(({ tab, label }) => (
          <Button
            key={tab}
            size="sm"
            role="tab"
            aria-selected={s.tab === tab}
            variant={s.tab === tab ? 'active' : 'default'}
            onClick={() => setTasksTab(tab)}
            data-testid={`tasks-tab-${tab}`}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-10">{content}</div>
    </div>
  );
}
