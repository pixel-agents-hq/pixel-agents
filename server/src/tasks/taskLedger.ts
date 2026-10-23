/**
 * TaskLedger: the Manager's task log -- what each session worked on today, one
 * task per title period (docs/office/DESIGN.md, phase M).
 *
 * A task is a session's title period:
 *  - It opens on the session's first activity (an `active` status or a counted
 *    tool), titled with the session's `ai-title`, or `Untitled · <repo>` before
 *    one exists -- renamed, not replaced, when the first title arrives.
 *  - A different title closes it as done and opens the next one, as does a new
 *    session under the same agent (/clear). The session ending (SessionEnd,
 *    dismissal, its process gone, a remote one expiring) closes it as done.
 *  - Status: `in_progress` on `active`, `waiting` on `waiting`, `done` when closed.
 *  - A remote (relayed) session has no transcript here, so no titles: it is one
 *    task per session, `💻 <source> · <repo>`, on machine <source>. A session
 *    back from expiry resumes its task.
 *  - Teammates and sub-agents get no tasks of their own: their work counts
 *    toward their lead's (hooks already attribute a sub-agent's tools to it).
 *    Background agents are real work and get their own.
 *  - Sessions running in the Manager's own working dir (<dataDir>/manager,
 *    where the report run happens) are never logged.
 *
 * Stats come from the ProgressTracker's own counting (its observe() events), so
 * a task's commands, files, pushes, PRs and active time are classified exactly
 * like the daily totals and land on the agent's live task at the time.
 *
 * Persistence: one file per local day, <dataDir>/tasks/<YYYY-MM-DD>.json, kept
 * forever; written at most every TASKS_SAVE_DEBOUNCE_MS (tmp + rename), flushed
 * on dispose and at midnight. An unreadable file is logged and the day starts
 * empty. Only the standalone CLI persists (AgentRuntime's `manager` option):
 * two surfaces writing one day file would clobber each other's tasks.
 *
 * Midnight: the first use after it writes the old day as it ended (open tasks
 * still open) and starts the new one with every open task carried over -- same
 * id, title, start and status, counters from zero, since each day's file counts
 * that day's work (as the daily totals do). The new day is announced with a
 * `tasksSnapshot`. A restart past midnight carries yesterday's open tasks the
 * same way.
 *
 * Restarts: shutting down closes nothing (no session ended). An agent re-adopted
 * afterwards picks its session's open task back up (renaming it, or splitting it
 * when the title moved on meanwhile); an open task nobody picks up within
 * TASK_ORPHAN_GRACE_MS is closed as done.
 *
 * Output: `taskUpdated` broadcasts on every change, snapshot() for a connecting
 * client (agentActivityResend.ts), tasksFor(date) for `requestTasks`.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  DailyPr,
  Task,
  TasksSnapshot,
  TaskStatus,
  TaskUpdated,
} from '../../../core/src/messages.js';
import { normalizeProjectPath } from '../../../core/src/normalizeProjectPath.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  LAYOUT_FILE_DIR,
  LOCAL_TASK_MACHINE,
  MANAGER_DIR_NAME,
  TASK_ORPHAN_GRACE_MS,
  TASKS_DIR_NAME,
  TASKS_SAVE_DEBOUNCE_MS,
  UNTITLED_TASK_TITLE,
} from '../constants.js';
import { pathsMatch } from '../pathKey.js';
import {
  localDateKey,
  type ProgressEvent,
  type ProgressTracker,
} from '../progress/progressTracker.js';
import type { AgentState } from '../types.js';
import { addNote, parseNotes, type WorkNotes } from './workNotes.js';

export interface TaskLedgerOptions {
  /** Root of the Manager's files (~/.pixel-agents by default): days live in
   *  <dataDir>/tasks. null keeps the log in memory only. */
  dataDir?: string | null;
  /** Clock (tests). */
  now?: () => number;
}

/** A task as the ledger keeps it: the wire shape plus what dedup and renaming need. */
interface LedgerTask extends Task {
  /** Hashed identities of the files counted in filesEdited (never paths). */
  fileKeys: Set<string>;
  /** Titled `Untitled · <repo>`: the first real title renames it rather than splitting. */
  placeholder?: true;
  /** What the work was, in words (workNotes.ts). Kept in the day file, never on the wire. */
  notes?: WorkNotes;
}

interface Day {
  date: string;
  tasks: LedgerTask[];
}

/** On-disk shape of <dataDir>/tasks/<date>.json. */
interface DayFile {
  version: 1;
  date: string;
  tasks: Array<Task & { fileKeys: string[]; placeholder?: true; notes?: WorkNotes }>;
}

/** What the ledger knows about one agent that can own tasks. */
interface AgentTasking {
  /** Its live task, in the current day. */
  taskId?: string;
  /** The session the live task and `title` belong to; a new one closes the task. */
  sessionId: string;
  /** The session's title as the ledger has seen it (undefined: none yet). */
  title?: string;
  /** The Manager's own session: never logged. */
  excluded: boolean;
}

const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['in_progress', 'waiting', 'done']);
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ~/.pixel-agents: where the task log, the reports and the Manager's working dir live. */
export function defaultManagerDataDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR);
}

/** A real calendar date written YYYY-MM-DD (the only names a day file can have). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(DATE_KEY_PATTERN);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

let currentLedger: TaskLedger | null = null;

/** The runtime's ledger, for agentActivityResend (set by AgentRuntime). */
export function setTaskLedger(ledger: TaskLedger | null): void {
  currentLedger = ledger;
}

export function getTaskLedger(): TaskLedger | null {
  return currentLedger;
}

export class TaskLedger {
  /** The current day; undefined until first used. */
  private day: Day | undefined;
  private readonly perAgent = new Map<number, AgentTasking>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly tasksDir: string | null;
  private readonly managerDir: string;
  private readonly now: () => number;
  private readonly unobserve: () => void;

  constructor(
    private readonly store: AgentStateStore,
    progress: ProgressTracker,
    options: TaskLedgerOptions = {},
  ) {
    const root = options.dataDir === undefined ? defaultManagerDataDir() : options.dataDir;
    this.tasksDir = root === null ? null : path.join(root, TASKS_DIR_NAME);
    this.managerDir = path.join(root ?? defaultManagerDataDir(), MANAGER_DIR_NAME);
    this.now = options.now ?? Date.now;
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
    store.on('broadcast', this.onBroadcast);
    this.unobserve = progress.observe(this.onProgress);
    if (this.tasksDir !== null) {
      // Restored and re-adopted sessions pick their open tasks back up well
      // within the grace; whatever is left open then belongs to a dead session.
      this.orphanTimer = setTimeout(() => {
        this.orphanTimer = null;
        this.sweepOrphans();
      }, TASK_ORPHAN_GRACE_MS);
      this.orphanTimer.unref?.();
    }
  }

  /** Is this the ledger for that store? */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  // ── Output ─────────────────────────────────────────────────

  /** Today's tasks, for a client that connects. */
  snapshot(): TasksSnapshot {
    return snapshotOf(this.today(this.now()));
  }

  /** A day's tasks: today's live list, another day's from its file. A missing
   *  day, an unreadable file or a malformed date is an empty list. */
  tasksFor(date: string): Task[] {
    if (!isDateKey(date)) return [];
    const day = this.today(this.now());
    if (date === day.date) return day.tasks.map(wireTask);
    if (this.tasksDir === null) return [];
    return readDay(this.tasksDir, date).tasks.map(wireTask);
  }

  /** A day's tasks with their work notes, for the Manager's report. */
  tasksWithNotesFor(date: string): Array<Task & { notes?: WorkNotes }> {
    if (!isDateKey(date)) return [];
    const day = this.today(this.now());
    const tasks =
      date === day.date
        ? day.tasks
        : this.tasksDir === null
          ? []
          : readDay(this.tasksDir, date).tasks;
    return tasks.map((task) => ({
      ...wireTask(task),
      ...(task.notes ? { notes: structuredClone(task.notes) } : {}),
    }));
  }

  /** Close every open task no live agent has picked up (after a restart). */
  sweepOrphans(): void {
    if (this.disposed) return;
    const now = this.now();
    const bound = this.boundTaskIds();
    for (const task of this.today(now).tasks) {
      if (task.status !== 'done' && !bound.has(task.id)) this.close(task, now);
    }
  }

  /** Write the current day now if it changed since the last write. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.day || this.tasksDir === null) return;
    // A failed write stays dirty, so the next change or dispose retries it.
    this.dirty = !writeDay(this.tasksDir, this.day);
  }

  /** Write any unsaved changes and stop listening. Closes no task: shutting the
   *  server down ends no session. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    this.unobserve();
    this.store.off('agentAdded', this.onAgentAdded);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.store.off('broadcast', this.onBroadcast);
    this.perAgent.clear();
  }

  // ── Inputs ─────────────────────────────────────────────────

  /** A new agent may be a restarted session's: pick its open task back up. */
  private readonly onAgentAdded = (id: number, agent: AgentState): void => {
    if (this.disposed || this.isFollower(agent)) return;
    const now = this.now();
    const state = this.sync(id, agent, now);
    if (!state || this.liveTask(state, now)) return;
    const task = this.latestUnbound(agent.sessionId, false, now);
    if (!task) return;
    state.taskId = task.id;
    const titleMovedOn =
      !agent.remoteSource &&
      state.title !== undefined &&
      !task.placeholder &&
      task.title !== state.title;
    // The title moved on while we were away: that task is over.
    if (titleMovedOn) this.split(task, state, agent, now);
    else this.refresh(task, agent, state);
  };

  private readonly onAgentRemoved = (id: number): void => {
    const state = this.perAgent.get(id);
    this.perAgent.delete(id);
    if (this.disposed || !state) return;
    const now = this.now();
    const task = this.liveTask(state, now);
    if (task) this.close(task, now);
  };

  /** agentStatus drives the status; agentTitle the title. The ledger's own
   *  broadcasts are neither, so they never loop back here. */
  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    if (this.disposed || typeof message.id !== 'number') return;
    if (message.type === 'agentStatus') {
      if (message.status === 'active' || message.status === 'waiting') {
        this.onStatus(message.id, message.status);
      }
    } else if (message.type === 'agentTitle' && typeof message.title === 'string') {
      this.onTitle(message.id, message.title);
    }
  };

  private onStatus(id: number, status: 'active' | 'waiting'): void {
    const agent = this.store.get(id);
    // A teammate's status is its own, not its lead's task's.
    if (!agent || this.isFollower(agent)) return;
    const now = this.now();
    if (status === 'active') {
      const task = this.taskFor(id, agent, now);
      if (task) this.setStatus(task, 'in_progress');
      return;
    }
    const state = this.sync(id, agent, now);
    const task = state && this.liveTask(state, now);
    if (task) this.setStatus(task, 'waiting');
  }

  private onTitle(id: number, title: string): void {
    const agent = this.store.get(id);
    // Remote sessions are one task each, whatever they are called.
    if (!agent || agent.remoteSource || this.isFollower(agent)) return;
    const now = this.now();
    const state = this.sync(id, agent, now);
    if (!state || state.title === title) return;
    state.title = title;
    const task = this.liveTask(state, now);
    if (!task) return;
    if (task.placeholder) this.refresh(task, agent, state);
    else this.split(task, state, agent, now);
  }

  /** A count from the ProgressTracker, credited to the live task of the agent
   *  it belongs to (its lead's, for a teammate). */
  private readonly onProgress = (event: ProgressEvent): void => {
    if (this.disposed) return;
    const owner = this.ownerOf(event.agentId);
    if (!owner) return;
    const task = this.taskFor(owner.id, owner.agent, event.at);
    if (!task) return;
    switch (event.kind) {
      case 'command':
        task.commands++;
        break;
      case 'fileEdited':
        if (task.fileKeys.has(event.fileKey)) return;
        task.fileKeys.add(event.fileKey);
        task.filesEdited++;
        break;
      case 'push':
        task.pushes++;
        break;
      case 'pr':
        task.prs.push({ ...event.pr });
        break;
      case 'activeTime':
        task.activeMs += event.ms;
        break;
      case 'note': {
        task.notes ??= { asks: [], outcomes: [], todos: [], commits: [] };
        const field =
          event.note === 'outcome' ? 'outcomes' : event.note === 'todo' ? 'todos' : 'commits';
        if (!addNote(task.notes, field, event.text)) return;
        break;
      }
    }
    this.changed(task);
  };

  // ── Agents ─────────────────────────────────────────────────

  /** Teammates and promoted sub-agents work for their lead while it is on the board. */
  private isFollower(agent: AgentState): boolean {
    return agent.leadAgentId !== undefined && this.store.has(agent.leadAgentId);
  }

  /** The agent whose task this agent's work counts toward. */
  private ownerOf(agentId: number): { id: number; agent: AgentState } | undefined {
    const agent = this.store.get(agentId);
    if (!agent) return undefined;
    if (agent.leadAgentId !== undefined) {
      const lead = this.store.get(agent.leadAgentId);
      if (lead) return { id: agent.leadAgentId, agent: lead };
    }
    return { id: agentId, agent };
  }

  /** The ledger's view of an owner agent, brought up to its current session;
   *  undefined for the Manager's own sessions. */
  private sync(id: number, agent: AgentState, now: number): AgentTasking | undefined {
    let state = this.perAgent.get(id);
    if (!state) {
      state = {
        sessionId: agent.sessionId,
        title: agent.remoteSource ? undefined : agent.title,
        excluded: isManagerSession(agent, this.managerDir),
      };
      this.perAgent.set(id, state);
    }
    if (state.excluded) return undefined;
    if (state.sessionId !== agent.sessionId) {
      const task = this.liveTask(state, now);
      if (task) {
        // A new session under the same agent (/clear): the old one's task is
        // over, and its title (still on the agent) was the old session's.
        this.close(task, now);
        state.title = undefined;
      } else {
        // Nothing ran under the old id -- adoption names an agent after its
        // transcript file, then takes the hook's session id: same session.
        state.title = agent.remoteSource ? undefined : agent.title;
      }
      state.taskId = undefined;
      state.sessionId = agent.sessionId;
    }
    return state;
  }

  /** The owner's live task, opened when it has none. */
  private taskFor(id: number, agent: AgentState, now: number): LedgerTask | undefined {
    const state = this.sync(id, agent, now);
    if (!state) return undefined;
    const live = this.liveTask(state, now);
    if (live) {
      this.refresh(live, agent, state);
      return live;
    }
    return this.open(state, agent, now, 'in_progress');
  }

  private liveTask(state: AgentTasking, now: number): LedgerTask | undefined {
    if (!state.taskId) return undefined;
    const task = this.today(now).tasks.find((t) => t.id === state.taskId);
    if (task && task.status !== 'done') return task;
    state.taskId = undefined;
    return undefined;
  }

  private boundTaskIds(): Set<string> {
    const ids = new Set<string>();
    for (const state of this.perAgent.values()) {
      if (state.taskId) ids.add(state.taskId);
    }
    return ids;
  }

  /** The session's newest task no agent holds: open ones only, or done ones too. */
  private latestUnbound(
    sessionId: string,
    includeDone: boolean,
    now: number,
  ): LedgerTask | undefined {
    const bound = this.boundTaskIds();
    const tasks = this.today(now).tasks;
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i];
      if (task.sessionId !== sessionId || bound.has(task.id)) continue;
      if (includeDone || task.status !== 'done') return task;
    }
    return undefined;
  }

  // ── Tasks ──────────────────────────────────────────────────

  private open(
    state: AgentTasking,
    agent: AgentState,
    now: number,
    status: TaskStatus,
  ): LedgerTask {
    if (agent.remoteSource) {
      // One task per remote session: one back from expiry resumes its own.
      const previous = this.latestUnbound(agent.sessionId, true, now);
      if (previous) {
        state.taskId = previous.id;
        previous.status = status;
        delete previous.endedAt;
        this.refresh(previous, agent, state);
        this.changed(previous);
        return previous;
      }
    }
    const identity = identityOf(agent, state);
    const task: LedgerTask = {
      id: randomUUID(),
      title: identity.title,
      repo: repoOf(agent),
      machine: agent.remoteSource?.label ?? LOCAL_TASK_MACHINE,
      sessionId: agent.sessionId,
      startedAt: now,
      status,
      prs: [],
      pushes: 0,
      filesEdited: 0,
      commands: 0,
      activeMs: 0,
      fileKeys: new Set(),
      ...(identity.placeholder ? { placeholder: true as const } : {}),
    };
    this.today(now).tasks.push(task);
    state.taskId = task.id;
    this.changed(task);
    return task;
  }

  /** A new title period: the task is done, the next one starts in its status. */
  private split(task: LedgerTask, state: AgentTasking, agent: AgentState, now: number): void {
    const status = task.status;
    this.close(task, now);
    this.open(state, agent, now, status);
  }

  private close(task: LedgerTask, now: number): void {
    task.status = 'done';
    task.endedAt = now;
    for (const state of this.perAgent.values()) {
      if (state.taskId === task.id) state.taskId = undefined;
    }
    this.changed(task);
  }

  private setStatus(task: LedgerTask, status: TaskStatus): void {
    if (task.status === status) return;
    task.status = status;
    this.changed(task);
  }

  /** Repo and title as the agent now has them: a placeholder takes the first
   *  real title (renamed, not replaced); a remote task follows its source. */
  private refresh(task: LedgerTask, agent: AgentState, state: AgentTasking): void {
    const repo = repoOf(agent);
    let title = task.title;
    let placeholder = task.placeholder === true;
    if (agent.remoteSource || placeholder) {
      ({ title, placeholder } = identityOf(agent, state));
    }
    if (repo === task.repo && title === task.title && placeholder === (task.placeholder === true)) {
      return;
    }
    task.repo = repo;
    task.title = title;
    if (placeholder) task.placeholder = true;
    else delete task.placeholder;
    this.changed(task);
  }

  private changed(task: LedgerTask): void {
    this.store.broadcast({ type: 'taskUpdated', task: wireTask(task) } satisfies TaskUpdated);
    this.markDirty();
  }

  // ── Days ───────────────────────────────────────────────────

  /** The current day: read on first use, carried into a fresh one after midnight. */
  private today(now: number): Day {
    const date = localDateKey(now);
    if (this.day?.date === date) return this.day;
    const rollover = this.day !== undefined;
    const previous = this.day ?? this.dayBefore(date);
    if (rollover) this.flush();
    const day = this.tasksDir === null ? emptyDay(date) : readDay(this.tasksDir, date);
    let carried = false;
    for (const task of previous?.tasks ?? []) {
      if (task.status === 'done' || day.tasks.some((t) => t.id === task.id)) continue;
      day.tasks.push(carryOver(task));
      carried = true;
    }
    this.day = day;
    if (carried) this.markDirty();
    if (rollover) this.store.broadcast({ ...snapshotOf(day) });
    return day;
  }

  /** On first load: the previous calendar day, when today has no file yet --
   *  a restart past midnight carries its open tasks too. */
  private dayBefore(date: string): Day | undefined {
    if (this.tasksDir === null || fs.existsSync(path.join(this.tasksDir, `${date}.json`))) {
      return undefined;
    }
    const [year, month, dayOfMonth] = date.split('-').map(Number);
    return readDay(
      this.tasksDir,
      localDateKey(new Date(year, month - 1, dayOfMonth - 1).getTime()),
    );
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.tasksDir === null || this.saveTimer || this.disposed) return;
    // Not a sliding debounce: a busy agent changes its task every few seconds,
    // and a timer that kept restarting would never write.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, TASKS_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** The repo an agent works in, as the office names it (as the daily totals do).
 *  The token meter attributes responses by the same name, so the time report
 *  can line a day's tokens up with its tasks. */
export function repoOf(agent: Pick<AgentState, 'directoryName'>): string {
  return agent.directoryName || 'unknown';
}

/** The title a task of this agent's should carry now. */
function identityOf(
  agent: AgentState,
  state: AgentTasking,
): { title: string; placeholder: boolean } {
  const repo = repoOf(agent);
  if (agent.remoteSource) {
    return { title: `💻 ${agent.remoteSource.label} · ${repo}`, placeholder: false };
  }
  if (state.title !== undefined) return { title: state.title, placeholder: false };
  return { title: `${UNTITLED_TASK_TITLE} · ${repo}`, placeholder: true };
}

/** Is this session running in the Manager's working dir? A hooks-only agent's
 *  projectDir is its cwd; a transcript-backed one's is Claude's encoded
 *  ~/.claude/projects/<cwd> dir. */
function isManagerSession(agent: AgentState, managerDir: string): boolean {
  if (!agent.projectDir) return false;
  if (pathsMatch(agent.projectDir, managerDir)) return true;
  return (
    path.basename(agent.projectDir).toLowerCase() === normalizeProjectPath(managerDir).toLowerCase()
  );
}

function wireTask(task: LedgerTask): Task {
  return {
    id: task.id,
    title: task.title,
    repo: task.repo,
    machine: task.machine,
    sessionId: task.sessionId,
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    status: task.status,
    prs: task.prs.map((p) => ({ ...p })),
    pushes: task.pushes,
    filesEdited: task.filesEdited,
    commands: task.commands,
    activeMs: task.activeMs,
  };
}

function snapshotOf(day: Day): TasksSnapshot {
  return { type: 'tasksSnapshot', date: day.date, tasks: day.tasks.map(wireTask) };
}

/** An open task in the new day: same identity and status, that day's counts from zero. */
function carryOver(task: LedgerTask): LedgerTask {
  return {
    ...task,
    prs: [],
    pushes: 0,
    filesEdited: 0,
    commands: 0,
    activeMs: 0,
    fileKeys: new Set(),
    notes: undefined,
  };
}

function emptyDay(date: string): Day {
  return { date, tasks: [] };
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parsePr(entry: unknown): DailyPr | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { title, repo, url, at } = entry as Record<string, unknown>;
  if (typeof title !== 'string' || typeof repo !== 'string' || typeof at !== 'number') {
    return undefined;
  }
  return { title, repo, ...(typeof url === 'string' ? { url } : {}), at };
}

/** One stored task, or undefined when it isn't one. */
function parseTask(entry: unknown): LedgerTask | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const raw = entry as Record<string, unknown>;
  const { id, title, repo, machine, sessionId, startedAt, endedAt, status } = raw;
  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof repo !== 'string' ||
    typeof machine !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof startedAt !== 'number' ||
    typeof status !== 'string' ||
    !TASK_STATUSES.has(status)
  ) {
    return undefined;
  }
  const prs = (Array.isArray(raw.prs) ? raw.prs : [])
    .map(parsePr)
    .filter((p): p is DailyPr => p !== undefined);
  const notes = parseNotes(raw.notes);
  const fileKeys = new Set(
    (Array.isArray(raw.fileKeys) ? raw.fileKeys : []).filter(
      (k): k is string => typeof k === 'string',
    ),
  );
  return {
    id,
    title,
    repo,
    machine,
    sessionId,
    startedAt,
    ...(typeof endedAt === 'number' ? { endedAt } : {}),
    status: status as TaskStatus,
    prs,
    pushes: countOf(raw.pushes),
    // The count is the authority; the keys only keep a file from counting twice.
    filesEdited: Math.max(countOf(raw.filesEdited), fileKeys.size),
    commands: countOf(raw.commands),
    activeMs: countOf(raw.activeMs),
    fileKeys,
    ...(raw.placeholder === true ? { placeholder: true as const } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** A day's file, or an empty day when it is missing or unreadable. */
function readDay(dir: string, date: string): Day {
  const file = path.join(dir, `${date}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    // A day nothing happened on has no file; anything else is worth a line.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[Pixel Agents] Ignoring unreadable task log ${file}:`, err);
    }
    return emptyDay(date);
  }
  const entries =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as DayFile).tasks)
      ? (raw as DayFile).tasks
      : [];
  return {
    date,
    tasks: entries.map(parseTask).filter((t): t is LedgerTask => t !== undefined),
  };
}

/** Atomic write (tmp + rename). Returns false, logged, on failure. */
function writeDay(dir: string, day: Day): boolean {
  const file = path.join(dir, `${day.date}.json`);
  const data: DayFile = {
    version: 1,
    date: day.date,
    tasks: day.tasks.map((task) => ({
      ...wireTask(task),
      fileKeys: [...task.fileKeys],
      ...(task.placeholder ? { placeholder: true as const } : {}),
      ...(task.notes ? { notes: task.notes } : {}),
    })),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Failed to write task log ${file}:`, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}
