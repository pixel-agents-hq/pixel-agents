/**
 * ProgressTracker: where each agent is in its current task (the EXPLORE · BUILD ·
 * TEST · SHIP track on its label, and how long it has been waiting on the user)
 * and what got done today (the strip along the bottom of the office).
 *
 * Per agent:
 *  - `phase` is the phase of its latest classified tool (see phase.ts), and
 *    `reached` the phases its current cycle has touched, in order.
 *  - A cycle ends when the agent ships, or when it goes PROGRESS_CYCLE_GAP_MS
 *    without a classified tool; the next classified tool starts a new one.
 *  - `waitingSince` is when its status last became `waiting`.
 *
 * Daily totals cover the local day: commands run, unique files edited, pushes
 * per repo, PRs opened, and active time. They live in
 * ~/.pixel-agents/daily/<YYYY-MM-DD>.json, read on first use, written at most
 * every DAILY_STATS_SAVE_DEBOUNCE_MS (tmp + rename) and flushed on dispose. The
 * first update after midnight closes the old day and starts a fresh one.
 *
 * Inputs: tool starts and ends from HookEventHandler (agents without hooks feed
 * tool starts from the transcript parser instead), and the store's own
 * `agentStatus` broadcasts and `agentRemoved` events. Output: `agentProgress`
 * and `dailyStats` broadcasts through the store, plus snapshot() for a client
 * that connects.
 *
 * Observers (observe()) hear each count as it is made -- a command, an edited
 * file, a push, a PR, a closed active span -- with the agent it belongs to.
 * The Manager's task log (tasks/taskLedger.ts) attributes them to that agent's
 * live task, so a task's stats and the daily totals come from ONE classifier.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  AgentProgress,
  DailyPr,
  DailyPush,
  DailyStats,
  WorkPhase,
} from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  DAILY_STATS_DIR_NAME,
  DAILY_STATS_SAVE_DEBOUNCE_MS,
  DEFAULT_PR_TITLE,
  LAYOUT_FILE_DIR,
  PROGRESS_CYCLE_GAP_MS,
} from '../constants.js';
import { toPathKey } from '../pathKey.js';
import { commitMessageOf, todosFromTool, type WorkNoteKind } from '../tasks/workNotes.js';
import type { AgentState } from '../types.js';
import {
  classifyTool,
  editedFileOf,
  findPrUrl,
  isPrCreateCommand,
  isPushCommand,
  isShellTool,
  prTitleFromCommand,
  repoFromPrUrl,
  shellCommandOf,
} from './phase.js';

export interface ProgressTrackerOptions {
  /** Where the daily files live: ~/.pixel-agents/daily by default. null keeps
   *  the totals in memory only. */
  dailyDir?: string | null;
  /** Clock (tests). */
  now?: () => number;
}

/** What a finished tool reported. */
export interface ToolEndResult {
  /** The tool's output (the hook's tool_response), searched for the PR url. */
  response?: unknown;
  /** The PR url the relay copied out of a remote session's tool_response before dropping it. */
  prUrl?: string;
  /** PostToolUseFailure: the tool failed, so nothing it did counts. */
  failed: boolean;
}

/** One count, as the tracker made it. `at` is the tracker's clock at the time. */
export type ProgressEvent =
  /** A shell tool started (counted in commandsRun). */
  | { kind: 'command'; agentId: number; at: number }
  /** A file edit started. Reported on every edit, not just a file's first of
   *  the day; `fileKey` is the file's hashed identity (never its path). */
  | { kind: 'fileEdited'; agentId: number; at: number; fileKey: string }
  /** A successful push (counted in pushes). */
  | { kind: 'push'; agentId: number; at: number; repo: string }
  /** A PR recorded in today's list (a repeat sighting of its url is not). */
  | { kind: 'pr'; agentId: number; at: number; pr: DailyPr }
  /** An active span closed by `waiting`: the ms added to activeMs, so clipped
   *  at midnight exactly as the totals are. */
  | { kind: 'activeTime'; agentId: number; at: number; ms: number }
  /** What the work was, in words: a plan item, a commit subject, or how a turn
   *  ended (the Stop hook's last reply). For the Manager's report (workNotes.ts). */
  | { kind: 'note'; agentId: number; at: number; note: WorkNoteKind; text: string };

export type ProgressObserver = (event: ProgressEvent) => void;

/** A PR to record: its url when known, else it can't be deduplicated. */
interface PrSighting {
  url?: string;
  title?: string;
  repo?: string;
}

/** A push, or a PR newly added to today's list (see ProgressTracker.onLanded). */
export type Landed = { kind: 'push'; repo: string } | { kind: 'pr'; pr: DailyPr };

interface AgentTrack {
  phase?: WorkPhase;
  reached: WorkPhase[];
  lastClassifiedAt?: number;
  waitingSince?: number;
  /** Start of the current active span, closed into activeMs by the next `waiting`. */
  activeSince?: number;
}

interface DailyTotals {
  date: string;
  prs: DailyPr[];
  pushes: DailyPush[];
  /** Hashed keys of the files edited today (see fileKey): the count survives a
   *  restart without the daily file listing paths. */
  files: Set<string>;
  commandsRun: number;
  activeMs: number;
}

/** On-disk shape of <dailyDir>/<date>.json. */
interface DailyFile {
  version: 1;
  date: string;
  prs: DailyPr[];
  pushes: DailyPush[];
  files: string[];
  commandsRun: number;
  activeMs: number;
}

export class ProgressTracker {
  private readonly perAgent = new Map<number, AgentTrack>();
  private readonly observers = new Set<ProgressObserver>();
  /** Today's totals; undefined until first used. */
  private day: DailyTotals | undefined;
  /** Totals changed since they were last written. */
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly dailyDir: string | null;
  private readonly now: () => number;
  /** Hears each push and new PR, attributed to its agent (the timeline, signals/). */
  private landedListener: ((agentId: number, landed: Landed) => void) | null = null;

  constructor(
    private readonly store: AgentStateStore,
    options: ProgressTrackerOptions = {},
  ) {
    this.dailyDir =
      options.dailyDir === undefined
        ? path.join(os.homedir(), LAYOUT_FILE_DIR, DAILY_STATS_DIR_NAME)
        : options.dailyDir;
    this.now = options.now ?? Date.now;
    store.on('broadcast', this.onBroadcast);
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** Is this the tracker for that store? The transcript parser also drives the
   *  shadow sub-agent store, whose tools must not count. */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  /** Hear about every push and every new PR as it lands (one listener; null removes it). */
  onLanded(listener: ((agentId: number, landed: Landed) => void) | null): void {
    this.landedListener = listener;
  }

  // ── Inputs ─────────────────────────────────────────────────

  /** A tool started: advance the agent's cycle, count commands and edited files. */
  onToolStart(agentId: number, toolName: string, input: Record<string, unknown>): void {
    const agent = this.store.get(agentId);
    if (this.disposed || !agent) return;
    const now = this.now();
    const day = this.today(now);
    let dailyChanged = false;
    if (isShellTool(toolName)) {
      day.commandsRun++;
      dailyChanged = true;
      this.emit({ kind: 'command', agentId, at: now });
    }
    const file = editedFileOf(toolName, input);
    if (file) {
      const key = fileKey(agent, file);
      if (!day.files.has(key)) {
        day.files.add(key);
        dailyChanged = true;
      }
      this.emit({ kind: 'fileEdited', agentId, at: now, fileKey: key });
    }
    for (const text of todosFromTool(toolName, input)) {
      this.emit({ kind: 'note', agentId, at: now, note: 'todo', text });
    }
    const phase = classifyTool(toolName, input);
    if (phase) this.advance(agentId, phase, now);
    if (dailyChanged) this.dailyChanged();
  }

  /** A turn ended with this reply (the Stop hook's last_assistant_message). */
  onTurnSummary(agentId: number, text: string): void {
    if (this.disposed || !this.store.has(agentId) || !text.trim()) return;
    this.emit({ kind: 'note', agentId, at: this.now(), note: 'outcome', text });
  }

  /** A tool finished: a successful `git push` or `gh pr create` lands in today's totals. */
  onToolEnd(
    agentId: number,
    toolName: string,
    input: Record<string, unknown>,
    result: ToolEndResult,
  ): void {
    const agent = this.store.get(agentId);
    if (this.disposed || !agent || result.failed) return;
    const command = shellCommandOf(toolName, input);
    if (!command) return;
    const commit = commitMessageOf(command);
    if (commit) this.emit({ kind: 'note', agentId, at: this.now(), note: 'commit', text: commit });
    const pushed = isPushCommand(command);
    const opened = isPrCreateCommand(command);
    if (!pushed && !opened) return;
    const now = this.now();
    const day = this.today(now);
    let changed = false;
    if (pushed) {
      const repo = repoOf(agent);
      const entry = day.pushes.find((p) => p.repo === repo);
      if (entry) entry.count++;
      else day.pushes.push({ repo, count: 1 });
      changed = true;
      this.emit({ kind: 'push', agentId, at: now, repo });
      this.landedListener?.(agentId, { kind: 'push', repo });
    }
    if (opened) {
      const url = findPrUrl(textOf(result.response)) ?? findPrUrl(result.prUrl);
      changed =
        this.addPr(day, agentId, agent, { url, title: prTitleFromCommand(command) }, now) ||
        changed;
    }
    if (changed) this.dailyChanged();
  }

  /** A PR an agent's transcript recorded (a `pr-link` record), for agents
   *  without hooks, whose tool ends never reach the tracker. */
  onPrLink(agentId: number, pr: { url: string; title?: string; repo?: string }): void {
    const agent = this.store.get(agentId);
    if (this.disposed || !agent || !pr.url.startsWith('https://')) return;
    const now = this.now();
    if (this.addPr(this.today(now), agentId, agent, pr, now)) this.dailyChanged();
  }

  /** Hear every count as it is made; returns the unsubscribe. */
  observe(observer: ProgressObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** The store's agentStatus broadcasts drive waitingSince and active time. Only
   *  agentStatus is read, so the tracker's own broadcasts never loop back here. */
  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    if (this.disposed || message.type !== 'agentStatus') return;
    const id = message.id;
    if (typeof id !== 'number' || !this.store.has(id)) return;
    if (message.status === 'active') this.markActive(id);
    else if (message.status === 'waiting') this.markWaiting(id);
  };

  private readonly onAgentRemoved = (id: number): void => {
    // An open active span is dropped, not counted: an agent removed mid-turn
    // (dismissed, or a remote one gone silent for hours) never said when it stopped.
    this.perAgent.delete(id);
  };

  // ── Output ─────────────────────────────────────────────────

  /** When the agent's current wait on the user began; undefined while it isn't
   *  waiting. Read by the phone alerts (alerts.ts). */
  waitingSinceOf(agentId: number): number | undefined {
    return this.perAgent.get(agentId)?.waitingSince;
  }

  /** What a connecting client is sent: every agent's progress, then today's totals. */
  snapshot(): Array<AgentProgress | DailyStats> {
    const messages: Array<AgentProgress | DailyStats> = [];
    for (const id of this.store.keys()) {
      messages.push(progressMessage(id, this.perAgent.get(id)));
    }
    messages.push(statsMessage(this.today(this.now())));
    return messages;
  }

  /** Write any unsaved totals and stop listening. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    this.observers.clear();
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentRemoved', this.onAgentRemoved);
  }

  // ── Per-agent cycle ────────────────────────────────────────

  private trackFor(agentId: number): AgentTrack {
    let track = this.perAgent.get(agentId);
    if (!track) {
      track = { reached: [] };
      this.perAgent.set(agentId, track);
    }
    return track;
  }

  private advance(agentId: number, phase: WorkPhase, now: number): void {
    const track = this.trackFor(agentId);
    const before = `${track.phase}|${track.reached.join()}`;
    const freshCycle =
      track.lastClassifiedAt === undefined ||
      now - track.lastClassifiedAt >= PROGRESS_CYCLE_GAP_MS ||
      // Shipping ends the cycle. Ship steps in a row (commit, push, PR) are one
      // shipping step, so only the first non-ship tool after them starts anew.
      (track.phase === 'ship' && phase !== 'ship');
    if (freshCycle) track.reached = [phase];
    else if (!track.reached.includes(phase)) track.reached.push(phase);
    track.phase = phase;
    track.lastClassifiedAt = now;
    if (`${track.phase}|${track.reached.join()}` !== before) this.broadcastAgent(agentId, track);
  }

  private markActive(agentId: number): void {
    const track = this.trackFor(agentId);
    // Every tool re-announces `active`; the span runs from the first one.
    track.activeSince ??= this.now();
    if (track.waitingSince !== undefined) {
      track.waitingSince = undefined;
      this.broadcastAgent(agentId, track);
    }
  }

  private markWaiting(agentId: number): void {
    const track = this.trackFor(agentId);
    const now = this.now();
    if (track.activeSince !== undefined) {
      // A span begun before midnight counts from midnight: yesterday is closed.
      const from = Math.max(track.activeSince, startOfLocalDay(now));
      track.activeSince = undefined;
      const ms = Math.max(0, now - from);
      this.today(now).activeMs += ms;
      this.dailyChanged();
      if (ms > 0) this.emit({ kind: 'activeTime', agentId, at: now, ms });
    }
    // `waiting` repeats (Stop, then the idle notification); the first one counts.
    if (track.waitingSince === undefined) {
      track.waitingSince = now;
      this.broadcastAgent(agentId, track);
    }
  }

  private broadcastAgent(agentId: number, track: AgentTrack): void {
    this.store.broadcast({ ...progressMessage(agentId, track) });
  }

  // ── Daily totals ───────────────────────────────────────────

  /** Today's totals: read on first use, replaced by a fresh day after midnight. */
  private today(now: number): DailyTotals {
    const date = localDateKey(now);
    if (this.day?.date === date) return this.day;
    const rollover = this.day !== undefined;
    if (rollover) this.flush();
    this.day = this.dailyDir === null ? emptyDay(date) : readDailyFile(this.dailyDir, date);
    if (rollover) this.store.broadcast({ ...statsMessage(this.day) });
    return this.day;
  }

  /** Record a PR; false when its url is already in today's list. */
  private addPr(
    day: DailyTotals,
    agentId: number,
    agent: AgentState,
    pr: PrSighting,
    at: number,
  ): boolean {
    if (pr.url && day.prs.some((p) => p.url === pr.url)) return false;
    const entry: DailyPr = {
      title: pr.title?.trim() || DEFAULT_PR_TITLE,
      repo: (pr.url && repoFromPrUrl(pr.url)) || pr.repo || repoOf(agent),
      ...(pr.url ? { url: pr.url } : {}),
      at,
    };
    day.prs.push(entry);
    this.emit({ kind: 'pr', agentId, at, pr: { ...entry } });
    this.landedListener?.(agent.id, { kind: 'pr', pr: { ...entry } });
    return true;
  }

  /** Tell every observer; one that throws is logged and never stops the count. */
  private emit(event: ProgressEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (err) {
        console.error('[Pixel Agents] Progress observer failed:', err);
      }
    }
  }

  private dailyChanged(): void {
    if (!this.day) return;
    this.store.broadcast({ ...statsMessage(this.day) });
    this.dirty = true;
    if (this.dailyDir === null || this.saveTimer) return;
    // Not a sliding debounce: a busy agent changes the totals every few
    // seconds, and a timer that kept restarting would never write.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, DAILY_STATS_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write the totals now if they changed since the last write. */
  private flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.day || this.dailyDir === null) return;
    // A failed write stays dirty, so the next change or dispose retries it.
    this.dirty = !writeDailyFile(this.dailyDir, this.day);
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** The repo an agent works in, as the office names it. */
function repoOf(agent: AgentState): string {
  return agent.directoryName || 'unknown';
}

/** A tool response as text: hooks deliver Bash's as { stdout, stderr, … }. */
function textOf(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  if (response === undefined || response === null) return undefined;
  try {
    return JSON.stringify(response);
  } catch {
    return undefined;
  }
}

/** Identity of an edited file, hashed so the daily file never lists paths. A
 *  remote session's paths are keyed by its source: every cloud sandbox has a
 *  /home/user/<repo>, and none of them is this machine's. */
function fileKey(agent: AgentState, file: string): string {
  const identity = agent.remoteSource ? `${agent.remoteSource.id}:${file}` : toPathKey(file);
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function progressMessage(id: number, track: AgentTrack | undefined): AgentProgress {
  return {
    type: 'agentProgress',
    id,
    ...(track?.phase ? { phase: track.phase } : {}),
    reached: [...(track?.reached ?? [])],
    ...(track?.waitingSince !== undefined ? { waitingSince: track.waitingSince } : {}),
  };
}

function statsMessage(day: DailyTotals): DailyStats {
  return {
    type: 'dailyStats',
    date: day.date,
    prs: day.prs.map((p) => ({ ...p })),
    pushes: day.pushes.map((p) => ({ ...p })),
    filesEdited: day.files.size,
    commandsRun: day.commandsRun,
    activeMs: day.activeMs,
  };
}

/** Local calendar date, YYYY-MM-DD: the key of the daily files (and the task log's). */
export function localDateKey(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyDay(date: string): DailyTotals {
  return { date, prs: [], pushes: [], files: new Set(), commandsRun: 0, activeMs: 0 };
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A daily file's totals, keeping only well-formed entries. */
function parseDailyFile(date: string, raw: unknown): DailyTotals {
  const day = emptyDay(date);
  if (typeof raw !== 'object' || raw === null) return day;
  const file = raw as Partial<Record<keyof DailyFile, unknown>>;
  for (const entry of Array.isArray(file.prs) ? file.prs : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { title, repo, url, at } = entry as Record<string, unknown>;
    if (typeof title !== 'string' || typeof repo !== 'string' || typeof at !== 'number') continue;
    day.prs.push({ title, repo, ...(typeof url === 'string' ? { url } : {}), at });
  }
  for (const entry of Array.isArray(file.pushes) ? file.pushes : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { repo, count } = entry as Record<string, unknown>;
    if (typeof repo === 'string' && countOf(count) > 0) {
      day.pushes.push({ repo, count: countOf(count) });
    }
  }
  for (const key of Array.isArray(file.files) ? file.files : []) {
    if (typeof key === 'string') day.files.add(key);
  }
  day.commandsRun = countOf(file.commandsRun);
  day.activeMs = countOf(file.activeMs);
  return day;
}

/** Today's file, or a fresh day when it is missing or unreadable. */
function readDailyFile(dir: string, date: string): DailyTotals {
  const file = path.join(dir, `${date}.json`);
  try {
    return parseDailyFile(date, JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[Pixel Agents] Ignoring unreadable daily totals ${file}:`, err);
    }
    return emptyDay(date);
  }
}

/** Atomic write (tmp + rename). Returns false, logged, on failure. */
function writeDailyFile(dir: string, day: DailyTotals): boolean {
  const file = path.join(dir, `${day.date}.json`);
  const data: DailyFile = {
    version: 1,
    date: day.date,
    prs: day.prs,
    pushes: day.pushes,
    files: [...day.files],
    commandsRun: day.commandsRun,
    activeMs: day.activeMs,
  };
  // Per-process tmp name: VS Code and standalone may both be writing today's file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Failed to write daily totals ${file}:`, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}
