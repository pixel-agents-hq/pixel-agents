/**
 * The Tasks board's pure half (docs/office/DESIGN.md, phase M): kanban
 * grouping and order, card formatting, and the store's reducer — which day a
 * live task lands on, report bookkeeping, and the Manager's walk on a
 * reportReady for today only.
 *
 * Run with: npm test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../core/src/messages.js';
import {
  boardSummary,
  formatDuration,
  groupTasks,
  isDateKey,
  localDateKey,
  machineBadge,
  taskCounts,
  taskDurationMs,
  upsertTask,
} from '../src/tasks/taskBoard.js';
import {
  closeTasksBoard,
  getTasksState,
  handleTasksMessage,
  initialTasksState,
  isTasksMessage,
  markReportWriting,
  openTasksBoard,
  reduceTasksMessage,
  resetTasksStore,
} from '../src/tasks/tasksStore.js';

const NOW = new Date(2026, 9, 18, 15, 0, 0).getTime(); // 2026-10-18 15:00 local
const TODAY = '2026-10-18';
const MIN = 60_000;

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: 'pixel-agents',
    machine: 'local',
    sessionId: `s-${id}`,
    startedAt: NOW - 60 * MIN,
    status: 'in_progress',
    prs: [],
    pushes: 0,
    filesEdited: 0,
    commands: 0,
    activeMs: 0,
    ...over,
  };
}

describe('groupTasks', () => {
  it('three columns in order: In progress, Waiting on you, Done', () => {
    const cols = groupTasks([
      task('a', { status: 'done', endedAt: NOW }),
      task('b', { status: 'waiting' }),
      task('c'),
    ]);
    expect(cols.map((c) => [c.title, c.tasks.map((t) => t.id)])).toEqual([
      ['In progress', ['c']],
      ['Waiting on you', ['b']],
      ['Done', ['a']],
    ]);
  });

  it('open tasks newest first; done tasks by when they finished; ties by id', () => {
    const cols = groupTasks([
      task('old', { startedAt: NOW - 90 * MIN }),
      task('new', { startedAt: NOW - 5 * MIN }),
      task('tie-b', { startedAt: NOW - 30 * MIN }),
      task('tie-a', { startedAt: NOW - 30 * MIN }),
      task('d1', { status: 'done', startedAt: NOW - 200 * MIN, endedAt: NOW - 10 * MIN }),
      task('d2', { status: 'done', startedAt: NOW - 20 * MIN, endedAt: NOW - 15 * MIN }),
      task('d3', { status: 'done', startedAt: NOW - 3 * MIN }), // no end: its start
    ]);
    expect(cols[0].tasks.map((t) => t.id)).toEqual(['new', 'tie-a', 'tie-b', 'old']);
    expect(cols[2].tasks.map((t) => t.id)).toEqual(['d3', 'd1', 'd2']);
  });

  it('never mutates its input, and drops unknown statuses', () => {
    const input = [task('b', { startedAt: NOW - 50 * MIN }), task('a', { startedAt: NOW })];
    const odd = { ...task('x'), status: 'archived' } as unknown as Task;
    const cols = groupTasks([...input, odd]);
    expect(input.map((t) => t.id)).toEqual(['b', 'a']);
    expect(cols.flatMap((c) => c.tasks).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('card formatting', () => {
  it('a machine badge only for tasks run elsewhere', () => {
    expect(machineBadge({ machine: 'local' })).toBeNull();
    expect(machineBadge({ machine: '' })).toBeNull();
    expect(machineBadge({ machine: 'laptop' })).toBe('💻 laptop');
  });

  it('counts leave out the zeros', () => {
    const pr = { title: 'Fix', repo: 'r', url: 'https://x/1', at: NOW };
    expect(taskCounts({ prs: [pr], pushes: 2, filesEdited: 5 })).toBe('🏆 1 · 📦 2 · ✏️ 5');
    expect(taskCounts({ prs: [], pushes: 0, filesEdited: 3 })).toBe('✏️ 3');
    expect(taskCounts({ prs: [], pushes: 0, filesEdited: 0 })).toBe('');
  });

  it('duration: start to end when done, to now while open', () => {
    expect(taskDurationMs(task('a', { startedAt: NOW - 42 * MIN }), NOW)).toBe(42 * MIN);
    expect(
      taskDurationMs(
        task('b', { status: 'done', startedAt: NOW - 90 * MIN, endedAt: NOW - 25 * MIN }),
        NOW,
      ),
    ).toBe(65 * MIN);
    expect(formatDuration(65 * MIN)).toBe('1h 05m');
    expect(formatDuration(17 * MIN)).toBe('17m');
  });

  it('summary and date keys', () => {
    expect(
      boardSummary([task('a'), task('b', { status: 'waiting' }), task('c', { status: 'done' })]),
    ).toBe('1 open · 1 waiting · 1 done');
    expect(localDateKey(NOW)).toBe(TODAY);
    expect(isDateKey(TODAY)).toBe(true);
    expect(isDateKey('18/10/2026')).toBe(false);
  });

  it('upsertTask replaces in place by id, or appends', () => {
    const list = [task('a'), task('b')];
    const renamed = task('a', { title: 'Renamed' });
    expect(upsertTask(list, renamed).map((t) => t.title)).toEqual(['Renamed', 'Task b']);
    expect(upsertTask(list, task('c')).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(list[0].title).toBe('Task a');
  });
});

describe('reduceTasksMessage', () => {
  it('a snapshot fills its day and marks the feature supported', () => {
    const s = reduceTasksMessage(
      initialTasksState(NOW),
      { type: 'tasksSnapshot', date: TODAY, tasks: [task('a')] },
      NOW,
    );
    expect(s.supported).toBe(true);
    expect(s.tasksByDate[TODAY].map((t) => t.id)).toEqual(['a']);
  });

  it('a live update lands on the day that lists it, else today', () => {
    let s = reduceTasksMessage(
      initialTasksState(NOW),
      { type: 'tasksSnapshot', date: '2026-10-17', tasks: [task('late')] },
      NOW,
    );
    s = reduceTasksMessage(s, { type: 'taskUpdated', task: task('late', { status: 'done' }) }, NOW);
    s = reduceTasksMessage(s, { type: 'taskUpdated', task: task('fresh') }, NOW);
    expect(s.tasksByDate['2026-10-17'].map((t) => [t.id, t.status])).toEqual([['late', 'done']]);
    expect(s.tasksByDate[TODAY].map((t) => t.id)).toEqual(['fresh']);
  });

  it('reports are kept per day; reportReady bumps that day’s counter', () => {
    let s = reduceTasksMessage(
      initialTasksState(NOW),
      { type: 'report', date: TODAY, exists: true, markdown: '# Hi', aiWritten: true },
      NOW,
    );
    s = reduceTasksMessage(s, { type: 'reportReady', date: TODAY }, NOW);
    s = reduceTasksMessage(s, { type: 'reportReady', date: TODAY }, NOW);
    expect(s.reports[TODAY].markdown).toBe('# Hi');
    expect(s.reportReadyCount[TODAY]).toBe(2);
  });

  it('only the four task-log messages are its business', () => {
    expect(isTasksMessage({ type: 'taskUpdated', task: task('a') })).toBe(true);
    expect(isTasksMessage({ type: 'agentCreated', id: 1 })).toBe(false);
    expect(isTasksMessage(null)).toBe(false);
  });
});

describe('the store', () => {
  afterEach(() => resetTasksStore(NOW));

  it('a reportReady for today sends the Manager over; another day does not', () => {
    resetTasksStore(NOW);
    const visit = vi.fn();
    expect(
      handleTasksMessage(
        { type: 'reportReady', date: '2026-10-17' },
        { onReportReadyToday: visit },
        NOW,
      ),
    ).toBe(true);
    expect(visit).not.toHaveBeenCalled();
    handleTasksMessage({ type: 'reportReady', date: TODAY }, { onReportReadyToday: visit }, NOW);
    expect(visit).toHaveBeenCalledTimes(1);
    expect(handleTasksMessage({ type: 'layoutLoaded' }, { onReportReadyToday: visit }, NOW)).toBe(
      false,
    );
  });

  it('open/close, and "Write report now" shows the report as being written', () => {
    resetTasksStore(NOW);
    openTasksBoard('report');
    expect(getTasksState()).toMatchObject({ open: true, tab: 'report', date: TODAY });
    markReportWriting(TODAY);
    expect(getTasksState().reports[TODAY]).toMatchObject({ writing: true, exists: false });
    closeTasksBoard();
    expect(getTasksState().open).toBe(false);
  });
});
