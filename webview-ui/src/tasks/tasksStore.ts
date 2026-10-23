/**
 * The Tasks board's state (docs/office/DESIGN.md, phase M), outside React so
 * both the message handler and the canvas (a click on the Manager) can reach
 * it without threading props: the day lists, the reports, and whether the
 * board is open on which tab and date.
 *
 * `reduceTasksMessage` is the pure half (tested); the store around it is a
 * tiny useSyncExternalStore source. Requests to the server are the board's
 * job (TasksBoard.tsx), so this module never touches the transport.
 */

import { useSyncExternalStore } from 'react';

import type { Report, Task, TimeReport } from '../../../core/src/messages.js';
import { localDateKey, upsertTask } from './taskBoard.js';
import { rangeKey } from './timeReport.js';

export type TasksTab = 'board' | 'history' | 'report' | 'time';

export interface TasksState {
  /** The server keeps a task log (a tasksSnapshot, report or timeReport arrived). */
  supported: boolean;
  tasksByDate: Record<string, Task[]>;
  reports: Record<string, Report>;
  /** reportReady count per date: the open Report tab re-requests on a bump. */
  reportReadyCount: Record<string, number>;
  /** The Time tab's reports, by range (timeReport.ts rangeKey: 'from..to'). */
  timeReports: Record<string, TimeReport>;
  open: boolean;
  tab: TasksTab;
  /** The History / Report tabs' day ('YYYY-MM-DD'). */
  date: string;
}

export function initialTasksState(now = Date.now()): TasksState {
  return {
    supported: false,
    tasksByDate: {},
    reports: {},
    reportReadyCount: {},
    timeReports: {},
    open: false,
    tab: 'board',
    date: localDateKey(now),
  };
}

/** The five task-log messages (others are ignored by the reducer). */
export type TasksMessage =
  | { type: 'tasksSnapshot'; date: string; tasks: Task[] }
  | { type: 'taskUpdated'; task: Task }
  | { type: 'reportReady'; date: string }
  | ({ type: 'report' } & Omit<Report, 'type'>)
  | TimeReport;

const TASK_MESSAGE_TYPES = new Set([
  'tasksSnapshot',
  'taskUpdated',
  'reportReady',
  'report',
  'timeReport',
]);

export function isTasksMessage(msg: unknown): msg is TasksMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    TASK_MESSAGE_TYPES.has((msg as { type?: unknown }).type as string)
  );
}

/** Apply a task-log message. `now` decides which day a live task lands on. */
export function reduceTasksMessage(state: TasksState, msg: TasksMessage, now: number): TasksState {
  switch (msg.type) {
    case 'tasksSnapshot':
      return {
        ...state,
        supported: true,
        tasksByDate: {
          ...state.tasksByDate,
          [msg.date]: Array.isArray(msg.tasks) ? msg.tasks : [],
        },
      };
    case 'taskUpdated': {
      // The day that already lists it (a task open across midnight), else today.
      const date =
        Object.keys(state.tasksByDate).find((d) =>
          state.tasksByDate[d].some((t) => t.id === msg.task.id),
        ) ?? localDateKey(now);
      return {
        ...state,
        tasksByDate: {
          ...state.tasksByDate,
          [date]: upsertTask(state.tasksByDate[date] ?? [], msg.task),
        },
      };
    }
    case 'reportReady':
      return {
        ...state,
        reportReadyCount: {
          ...state.reportReadyCount,
          [msg.date]: (state.reportReadyCount[msg.date] ?? 0) + 1,
        },
      };
    case 'report':
      return {
        ...state,
        supported: true,
        reports: { ...state.reports, [msg.date]: msg as Report },
      };
    case 'timeReport':
      return {
        ...state,
        supported: true,
        timeReports: {
          ...state.timeReports,
          [rangeKey(msg)]: {
            ...msg,
            rows: Array.isArray(msg.rows) ? msg.rows : [],
            unattributed: Array.isArray(msg.unattributed) ? msg.unattributed : [],
          },
        },
      };
  }
}

// ── The store ─────────────────────────────────────────────────

let state: TasksState = initialTasksState();
const listeners = new Set<() => void>();

function setState(next: TasksState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function getTasksState(): TasksState {
  return state;
}

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTasksState(): TasksState {
  return useSyncExternalStore(subscribeTasks, getTasksState);
}

/**
 * Feed a server message to the store. True when it was a task-log message
 * (the caller stops there). A reportReady for today also runs
 * `onReportReadyToday` — the Manager's walk to Ansh's desk.
 */
export function handleTasksMessage(
  msg: unknown,
  hooks: { onReportReadyToday?: () => void } = {},
  now = Date.now(),
): boolean {
  if (!isTasksMessage(msg)) return false;
  setState(reduceTasksMessage(state, msg, now));
  if (msg.type === 'reportReady' && msg.date === localDateKey(now)) hooks.onReportReadyToday?.();
  return true;
}

export function openTasksBoard(tab?: TasksTab): void {
  setState({ ...state, open: true, tab: tab ?? state.tab });
}

export function closeTasksBoard(): void {
  if (state.open) setState({ ...state, open: false });
}

export function setTasksTab(tab: TasksTab): void {
  if (state.tab !== tab) setState({ ...state, tab });
}

export function setTasksDate(date: string): void {
  if (state.date !== date) setState({ ...state, date });
}

/** "Write report now" was sent: show today's report as being written until the server answers. */
export function markReportWriting(date: string): void {
  const current = state.reports[date];
  setState({
    ...state,
    reports: {
      ...state.reports,
      [date]: { ...(current ?? { type: 'report', date, exists: false }), writing: true },
    },
  });
}

/** Tests only: back to a fresh store. */
export function resetTasksStore(now = Date.now()): void {
  state = initialTasksState(now);
  for (const l of listeners) l();
}
