/**
 * The "Needs you" inbox as pure rules (DOM-free, so they run on the Node
 * runner): which agents are waiting on the user and why, oldest first; which
 * are paused by a usage limit; the strings the inbox, the labels and the TODAY
 * strip show; and the one URL shape "Open in Claude" may open.
 * docs/office/DESIGN.md, phase G. InboxPanel.tsx draws them.
 */

import type { LimitReason } from '../../../core/src/messages.js';

/** What the server says about getting back to a session (agentLink). */
export interface AgentLinkState {
  /** https://claude.ai/code/session_… when the session runs Remote Control. */
  url?: string;
  /** `cd "<cwd>" && claude --resume <id>` (bare for remote sessions). */
  resumeCommand: string;
}

/** A usage-limit pause in force (agentLimit paused: true). */
export interface AgentLimitState {
  reason?: LimitReason;
  /** When the limit lifts (epoch ms), when the server could tell. */
  resetsAt?: number;
}

/** Why an agent is waiting on the user. */
export type WaitReason = 'done' | 'permission' | 'question';

export const WAIT_REASON_LABELS: Record<WaitReason, string> = {
  done: '✅ turn done',
  permission: '🔐 permission',
  question: '❓ question',
};

const LIMIT_REASON_LABELS: Record<LimitReason, string> = {
  session: 'session limit',
  weekly: 'weekly limit',
  usage: 'usage limit',
  rate: 'rate limit',
};

/** Everything the office knows about one agent, reduced to the inbox's inputs. */
export interface InboxAgent {
  id: number;
  title?: string;
  /** The agent's Directory (repo) name. */
  repo?: string;
  /** Where a relayed remote session runs ("Mac"); absent for this machine. */
  machine?: string;
  /** agentStatuses entry: 'waiting' once its turn ended. */
  status?: string;
  /** A tool waits on a permission. */
  permission: boolean;
  /** A live AskUserQuestion tool. */
  asking: boolean;
  /** agentProgress.waitingSince: when its turn ended (epoch ms). */
  waitingSince?: number;
  /** When the pending permission was asked (epoch ms), when seen. */
  permissionSince?: number;
  /** When the live question was asked (epoch ms), when seen. */
  askingSince?: number;
  limit?: AgentLimitState;
  link?: AgentLinkState;
}

export interface InboxRow {
  id: number;
  reason: WaitReason;
  /** When the wait began (epoch ms). */
  since: number;
  /** `title · repo · machine`. */
  label: string;
  link?: AgentLinkState;
}

export interface PausedRow {
  id: number;
  label: string;
  reason?: LimitReason;
  resetsAt?: number;
  link?: AgentLinkState;
}

export interface Inbox {
  /** Waiting on the user, oldest wait first. */
  waiting: InboxRow[];
  /** Paused by a usage limit, soonest resume first (unknown resets last). */
  paused: PausedRow[];
}

/** The machine an inbox row names for a session on this computer. */
export const LOCAL_MACHINE_LABEL = 'local';

/** `title · repo · machine`, each part only when known. */
export function inboxLabel(agent: Pick<InboxAgent, 'id' | 'title' | 'repo' | 'machine'>): string {
  const parts = [
    agent.title?.trim() || (agent.repo ? undefined : `Agent ${agent.id}`),
    agent.repo,
    agent.machine ?? LOCAL_MACHINE_LABEL,
  ].filter((p): p is string => !!p);
  return parts.join(' · ');
}

/**
 * The inbox. A paused agent is never "waiting on you": it goes to the paused
 * group whatever its status. Otherwise a live question outranks a pending
 * permission (an AskUserQuestion raises a permission prompt of its own, and
 * is still a question), which outranks a finished turn.
 */
export function buildInbox(agents: Iterable<InboxAgent>, now: number): Inbox {
  const waiting: InboxRow[] = [];
  const paused: PausedRow[] = [];
  for (const agent of agents) {
    const label = inboxLabel(agent);
    if (agent.limit) {
      paused.push({
        id: agent.id,
        label,
        reason: agent.limit.reason,
        resetsAt: agent.limit.resetsAt,
        link: agent.link,
      });
      continue;
    }
    let reason: WaitReason | null = null;
    let since: number | undefined;
    if (agent.asking) {
      reason = 'question';
      since = agent.askingSince;
    } else if (agent.permission) {
      reason = 'permission';
      since = agent.permissionSince;
    } else if (agent.status === 'waiting') {
      reason = 'done';
      since = agent.waitingSince;
    }
    if (!reason) continue;
    waiting.push({
      id: agent.id,
      reason,
      since: Math.min(since ?? agent.waitingSince ?? now, now),
      label,
      link: agent.link,
    });
  }
  waiting.sort((a, b) => a.since - b.since || a.id - b.id);
  paused.sort(
    (a, b) =>
      (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY) ||
      a.id - b.id,
  );
  return { waiting, paused };
}

// ── Formatting ───────────────────────────────────────────────

/** "6:30 pm" (local); another day's time gets its weekday: "Mon 9:00 am". */
export function formatClock(epochMs: number, now: number): string {
  const at = new Date(epochMs);
  const hours = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, '0');
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
}

/** "45s", "14m", "1h 12m", "2d 3h": time left until a reset. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) return `${totalHours}h ${String(totalMin % 60).padStart(2, '0')}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

/** The paused row's second line: "session limit · resumes in 1h 12m". */
export function resumeText(row: Pick<PausedRow, 'reason' | 'resetsAt'>, now: number): string {
  const reason = row.reason ? LIMIT_REASON_LABELS[row.reason] : 'usage limit';
  if (row.resetsAt === undefined) return `${reason} · reset time unknown`;
  if (row.resetsAt <= now) return `${reason} · resuming`;
  return `${reason} · resumes in ${formatDuration(row.resetsAt - now)}`;
}

/** The label tag: "⏸️ paused until 6:30 pm" (or just "⏸️ paused"). */
export function pausedTag(limit: AgentLimitState, now: number): string {
  return limit.resetsAt !== undefined && limit.resetsAt > now
    ? `⏸️ paused until ${formatClock(limit.resetsAt, now)}`
    : '⏸️ paused';
}

/** The TODAY strip's "⏸️ 2 paused · resume 6:30 pm", or null with none paused. */
export function pausedSummary(
  limits: Record<number, AgentLimitState>,
  now: number,
  agentIds?: ReadonlySet<number>,
): string | null {
  let count = 0;
  let soonest: number | undefined;
  for (const [key, limit] of Object.entries(limits)) {
    if (agentIds && !agentIds.has(Number(key))) continue;
    count++;
    if (limit.resetsAt !== undefined && limit.resetsAt > now) {
      soonest = soonest === undefined ? limit.resetsAt : Math.min(soonest, limit.resetsAt);
    }
  }
  if (count === 0) return null;
  const head = `⏸️ ${count} paused`;
  return soonest === undefined ? head : `${head} · resume ${formatClock(soonest, now)}`;
}

// ── Open in Claude ───────────────────────────────────────────

const CLAUDE_HOST = 'claude.ai';
const CLAUDE_CODE_PATH_PREFIX = '/code/';

/**
 * The URL when it is a claude.ai/code page over https -- the only thing
 * "Open in Claude" opens -- else undefined. The server builds these links,
 * but a link is an action, so the client checks the shape itself.
 */
export function safeClaudeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== CLAUDE_HOST) return undefined;
    if (parsed.username || parsed.password || parsed.port) return undefined;
    if (!parsed.pathname.startsWith(CLAUDE_CODE_PATH_PREFIX)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
