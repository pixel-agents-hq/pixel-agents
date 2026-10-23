/**
 * Tap-for-timeline: per agent, a ring buffer of its last actions plus what it
 * landed today (PRs, pushes) and how long it worked today. Entry text is the
 * activity label (formatToolStatus), never a raw tool input.
 */

import type {
  AgentTimeline,
  DailyPr,
  TimelineEntry,
  TimelineKind,
} from '../../../core/src/messages.js';
import { TIMELINE_MAX_ENTRIES, TIMELINE_TEXT_MAX_CHARS } from './constants.js';
import { localDateKey, startOfLocalDay } from './localDay.js';

interface AgentLog {
  entries: TimelineEntry[];
  /** tool_use id -> its entry, to mark the entry when the tool fails. */
  byToolId: Map<string, TimelineEntry>;
  date: string;
  prs: DailyPr[];
  pushes: number;
  activeMs: number;
  activeSince?: number;
  /** Last status entry's text, so repeats don't fill the buffer. */
  lastStatus?: string;
}

function clip(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= TIMELINE_TEXT_MAX_CHARS
    ? chars.join('')
    : `${chars.slice(0, TIMELINE_TEXT_MAX_CHARS - 1).join('')}…`;
}

export class Timeline {
  private readonly logs = new Map<number, AgentLog>();

  constructor(private readonly now: () => number) {}

  /** The agent's log, its daily figures reset when the local day changed. */
  private logFor(id: number): AgentLog {
    const now = this.now();
    const date = localDateKey(now);
    let log = this.logs.get(id);
    if (!log) {
      log = { entries: [], byToolId: new Map(), date, prs: [], pushes: 0, activeMs: 0 };
      this.logs.set(id, log);
    } else if (log.date !== date) {
      log.date = date;
      log.prs = [];
      log.pushes = 0;
      log.activeMs = 0;
      if (log.activeSince !== undefined)
        log.activeSince = Math.max(log.activeSince, startOfLocalDay(now));
    }
    return log;
  }

  add(id: number, kind: TimelineKind, text: string, toolId?: string): void {
    const log = this.logFor(id);
    const entry: TimelineEntry = { at: this.now(), kind, text: clip(text) };
    log.entries.push(entry);
    if (toolId) log.byToolId.set(toolId, entry);
    while (log.entries.length > TIMELINE_MAX_ENTRIES) {
      const dropped = log.entries.shift();
      for (const [key, e] of log.byToolId) if (e === dropped) log.byToolId.delete(key);
    }
    if (kind !== 'status') log.lastStatus = undefined;
  }

  /** A status line, skipped when it repeats the previous one. */
  addStatus(id: number, text: string): void {
    const log = this.logFor(id);
    if (log.lastStatus === text) return;
    this.add(id, 'status', text);
    log.lastStatus = text;
  }

  /** Mark a tool's entry failed (the newest tool entry when its id is unknown). */
  markFailed(id: number, toolId: string | undefined): void {
    const log = this.logs.get(id);
    if (!log) return;
    const entry =
      (toolId ? log.byToolId.get(toolId) : undefined) ??
      [...log.entries].reverse().find((e) => e.kind === 'tool');
    if (entry) entry.failed = true;
  }

  pr(id: number, pr: DailyPr): void {
    const log = this.logFor(id);
    if (!pr.url || !log.prs.some((p) => p.url === pr.url)) log.prs.push({ ...pr });
    this.add(id, 'pr', `Opened PR: ${pr.title}`);
  }

  push(id: number, repo: string): void {
    this.logFor(id).pushes++;
    this.add(id, 'push', `Pushed ${repo}`);
  }

  onActive(id: number): void {
    this.logFor(id).activeSince ??= this.now();
  }

  onWaiting(id: number): void {
    const log = this.logFor(id);
    if (log.activeSince === undefined) return;
    log.activeMs += Math.max(0, this.now() - log.activeSince);
    log.activeSince = undefined;
  }

  remove(id: number): void {
    this.logs.delete(id);
  }

  message(id: number): AgentTimeline {
    const log = this.logFor(id);
    const open = log.activeSince !== undefined ? Math.max(0, this.now() - log.activeSince) : 0;
    return {
      type: 'agentTimeline',
      id,
      entries: log.entries.map((e) => ({ ...e })),
      prs: log.prs.map((p) => ({ ...p })),
      pushes: log.pushes,
      activeMs: log.activeMs + open,
    };
  }
}
