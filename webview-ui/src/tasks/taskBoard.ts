/**
 * The Tasks board's pure half (docs/office/DESIGN.md, phase M): kanban
 * grouping and order, card formatting, local date keys, and merging live
 * updates into a day's list. DOM-free, so it unit-tests in the Node runner.
 */

import type { Task, TaskStatus } from '../../../core/src/messages.js';
import { formatWait } from '../progress/progressFormat.js';

/** The machine label the server gives tasks run on this PC. */
export const LOCAL_MACHINE = 'local';

export interface KanbanColumn {
  status: TaskStatus;
  title: string;
  tasks: Task[];
}

/** Column order and headings. */
export const KANBAN_COLUMNS: ReadonlyArray<{ status: TaskStatus; title: string }> = [
  { status: 'in_progress', title: 'In progress' },
  { status: 'waiting', title: 'Waiting on you' },
  { status: 'done', title: 'Done' },
];

/** When a done task finished (its start, if the end is missing). */
const finishedAt = (t: Task) => t.endedAt ?? t.startedAt;

/**
 * Tasks into the three columns. Open tasks (in progress, waiting) newest
 * first; done tasks by when they finished, most recent first. Ties fall back
 * to the id, so the order never flickers between renders. Never mutates
 * the input. Unknown statuses are dropped.
 */
export function groupTasks(tasks: readonly Task[]): KanbanColumn[] {
  const byId = (a: Task, b: Task) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return KANBAN_COLUMNS.map(({ status, title }) => {
    const list = tasks.filter((t) => t.status === status);
    list.sort(
      status === 'done'
        ? (a, b) => finishedAt(b) - finishedAt(a) || byId(a, b)
        : (a, b) => b.startedAt - a.startedAt || byId(a, b),
    );
    return { status, title, tasks: list };
  });
}

/** Wall-clock length: start to end, or to `now` while still open. */
export function taskDurationMs(task: Task, now: number): number {
  const end = task.status === 'done' ? (task.endedAt ?? now) : now;
  return Math.max(0, end - task.startedAt);
}

/** '42s', '17m', '1h 05m'. */
export function formatDuration(ms: number): string {
  return formatWait(ms);
}

/** The machine badge ('💻 laptop') for a task run elsewhere; null on this PC. */
export function machineBadge(task: Pick<Task, 'machine'>): string | null {
  if (!task.machine || task.machine === LOCAL_MACHINE) return null;
  return `💻 ${task.machine}`;
}

/** The card's count line: PRs, pushes, files edited ('🏆 1 · 📦 2 · ✏️ 5'),
 *  leaving out the zeros; empty when there is nothing to count. */
export function taskCounts(task: Pick<Task, 'prs' | 'pushes' | 'filesEdited'>): string {
  const parts: string[] = [];
  if (task.prs.length > 0) parts.push(`🏆 ${task.prs.length}`);
  if (task.pushes > 0) parts.push(`📦 ${task.pushes}`);
  if (task.filesEdited > 0) parts.push(`✏️ ${task.filesEdited}`);
  return parts.join(' · ');
}

/** 'HH:MM' in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' for a moment, in local time (the server's day files are local too). */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** A well-formed 'YYYY-MM-DD' (what the date picker and the protocol carry). */
export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** A live taskUpdated merged into a day's list: replaced in place by id, or appended. */
export function upsertTask(tasks: readonly Task[], task: Task): Task[] {
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i < 0) return [...tasks, task];
  const next = tasks.slice();
  next[i] = task;
  return next;
}

/** A one-line summary for the board's header: '3 open · 1 waiting · 5 done'. */
export function boardSummary(tasks: readonly Task[]): string {
  let open = 0;
  let waiting = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.status === 'in_progress') open++;
    else if (t.status === 'waiting') waiting++;
    else if (t.status === 'done') done++;
  }
  return `${open} open · ${waiting} waiting · ${done} done`;
}
