/**
 * The server half of the "Needs you" inbox (docs/office/DESIGN.md, phase G):
 *
 * - **Links** (`agentLink`): per agent, the claude.ai/code URL of its Remote
 *   Control session when it has one, and the terminal resume command. Seeded
 *   from the transcript when the agent appears, followed live through
 *   `bridge-session` records, re-sent only when it changes.
 * - **Usage limits** (`agentLimit`): an agent whose turn stopped on a usage
 *   limit is paused until the limit resets. Detected from transcript API-error
 *   records, the StopFailure hook and limit Notifications (usageLimit.ts).
 *   Cleared at the reset time, on the agent's next tool activity, or on a real
 *   model response in its transcript.
 *
 * The webview builds the inbox itself from what it already has (statuses,
 * waitingSince, permissions); this module only adds what the server alone
 * knows. No transcript text is ever sent.
 *
 * Like ProgressTracker it listens to the store and is reached through a
 * module-level getter, so the transcript parser, the hook handler and the
 * connect-time resend need one line each.
 */

import type { AgentLimit, AgentLink } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';
import type { TranscriptSeed } from './agentLinks.js';
import { agentLinkMessage, bridgeSessionIdOf, readTranscriptSeed } from './agentLinks.js';
import { USAGE_LIMIT_FALLBACK_PAUSE_MS } from './constants.js';
import type { LimitReason, UsageLimitInfo } from './usageLimit.js';
import { isModelResponse, usageLimitFromRecord } from './usageLimit.js';

export interface InboxTrackerOptions {
  /** Clock (tests). */
  now?: () => number;
  /** Transcript seed reader (tests). */
  readSeed?: (file: string) => TranscriptSeed;
  /** How long a pause with no known reset time lasts. */
  fallbackPauseMs?: number;
}

interface LinkState {
  /** The transcript the state was read from; a new one (/clear) re-seeds. */
  file: string;
  bridgeSessionId?: string;
  cwd?: string;
  /** The last agentLink sent, serialized, so unchanged links aren't re-sent. */
  sent?: string;
  /** The seed's trailing API-error record, consumed once when the agent appears. */
  seedError?: unknown;
}

interface LimitState {
  info: UsageLimitInfo;
  timer: ReturnType<typeof setTimeout>;
}

/** Broadcasts that mean the agent is working again. */
const ACTIVITY_MESSAGES = new Set(['agentToolStart', 'subagentToolStart']);

export class InboxTracker {
  private readonly links = new Map<number, LinkState>();
  private readonly limits = new Map<number, LimitState>();
  private readonly now: () => number;
  private readonly readSeed: (file: string) => TranscriptSeed;
  private readonly fallbackPauseMs: number;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    options: InboxTrackerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.readSeed = options.readSeed ?? readTranscriptSeed;
    this.fallbackPauseMs = options.fallbackPauseMs ?? USAGE_LIMIT_FALLBACK_PAUSE_MS;
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
    store.on('broadcast', this.onBroadcast);
  }

  /** Is this the tracker for that store? (The transcript parser also drives
   *  the shadow sub-agent store, which has no inbox.) */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  // ── Inputs ─────────────────────────────────────────────────

  /** One parsed transcript record of a watched agent. */
  onTranscriptRecord(agentId: number, record: unknown): void {
    const agent = this.store.get(agentId);
    if (this.disposed || !agent) return;
    const state = this.linkState(agentId, agent);
    const bridgeSessionId = bridgeSessionIdOf(record);
    if (bridgeSessionId) state.bridgeSessionId = bridgeSessionId;
    this.publishLink(agentId, agent, state);

    const limit = usageLimitFromRecord(record, this.now());
    if (limit) this.onUsageLimit(agentId, limit);
    else if (isModelResponse(record)) this.clearLimit(agentId);
  }

  /** A source reported that the agent hit a usage limit. A pause already in
   *  force keeps its known reset time when the new report has none. */
  onUsageLimit(agentId: number, info: UsageLimitInfo): void {
    if (this.disposed || !this.store.has(agentId)) return;
    const now = this.now();
    const previous = this.limits.get(agentId);
    const resetsAt = info.resetsAt ?? previous?.info.resetsAt;
    if (resetsAt !== undefined && resetsAt <= now) {
      // Already over (a stale record): nothing to pause.
      if (info.resetsAt !== undefined) this.clearLimit(agentId);
      return;
    }
    const next: UsageLimitInfo =
      resetsAt === undefined ? { reason: info.reason } : { reason: info.reason, resetsAt };
    if (previous && previous.info.reason === next.reason && previous.info.resetsAt === resetsAt) {
      return;
    }
    if (previous) clearTimeout(previous.timer);
    const until = resetsAt ?? now + this.fallbackPauseMs;
    const timer = setTimeout(() => this.clearLimit(agentId), Math.max(0, until - now));
    timer.unref?.();
    this.limits.set(agentId, { info: next, timer });
    this.store.broadcast({ ...limitMessage(agentId, next) });
  }

  // ── Output ─────────────────────────────────────────────────

  /** What a connecting client is sent: every agent's link, then every pause. */
  snapshot(): Array<AgentLink | AgentLimit> {
    const messages: Array<AgentLink | AgentLimit> = [];
    for (const [id, agent] of this.store) {
      messages.push(agentLinkMessage(id, agent, this.linkState(id, agent)));
    }
    for (const [id, limit] of this.limits) {
      if (this.store.has(id)) messages.push(limitMessage(id, limit.info));
    }
    return messages;
  }

  /** Is the agent paused right now (tests, diagnostics)? */
  isPaused(agentId: number): boolean {
    return this.limits.has(agentId);
  }

  /** Which limit pauses the agent right now, if one does. */
  limitReasonOf(agentId: number): LimitReason | undefined {
    return this.limits.get(agentId)?.info.reason;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const limit of this.limits.values()) clearTimeout(limit.timer);
    this.limits.clear();
    this.links.clear();
    this.store.off('agentAdded', this.onAgentAdded);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.store.off('broadcast', this.onBroadcast);
  }

  // ── Internals ──────────────────────────────────────────────

  /** A new agent: seed its link (and a pause its last turn ended on) from the
   *  transcript. Deferred a tick: adoption sets the session id right after the
   *  agent is added, and the client should hear agentCreated first. */
  private readonly onAgentAdded = (id: number): void => {
    queueMicrotask(() => {
      const agent = this.store.get(id);
      if (this.disposed || !agent) return;
      const state = this.linkState(id, agent);
      this.publishLink(id, agent, state);
      const seededError = state.seedError;
      state.seedError = undefined;
      if (seededError) {
        const limit = usageLimitFromRecord(seededError, this.now());
        // Only a pause with a known, future reset is believed from history.
        if (limit?.resetsAt !== undefined) this.onUsageLimit(id, limit);
      }
    });
  };

  private readonly onAgentRemoved = (id: number): void => {
    this.links.delete(id);
    const limit = this.limits.get(id);
    if (limit) clearTimeout(limit.timer);
    this.limits.delete(id);
  };

  /** Tool activity un-pauses (this tracker's own broadcasts never match). */
  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    if (this.disposed || typeof message.type !== 'string') return;
    if (!ACTIVITY_MESSAGES.has(message.type)) return;
    if (typeof message.id === 'number') this.clearLimit(message.id);
  };

  private clearLimit(agentId: number): void {
    const limit = this.limits.get(agentId);
    if (!limit) return;
    clearTimeout(limit.timer);
    this.limits.delete(agentId);
    if (!this.disposed && this.store.has(agentId)) {
      this.store.broadcast({ type: 'agentLimit', id: agentId, paused: false } satisfies AgentLimit);
    }
  }

  /** The agent's link state, (re-)seeded from its transcript when it has a
   *  new one. */
  private linkState(id: number, agent: AgentState): LinkState {
    const file = agent.jsonlFile ?? '';
    let state = this.links.get(id);
    if (!state || state.file !== file) {
      const seed = file && !agent.remoteSource ? this.readSeed(file) : {};
      state = {
        file,
        bridgeSessionId: seed.bridgeSessionId,
        // A hooks-only local session has no transcript: its project dir is its cwd.
        cwd: seed.cwd ?? (agent.hooksOnly && !agent.remoteSource ? agent.projectDir : undefined),
        seedError: seed.lastApiError,
        sent: state?.sent,
      };
      this.links.set(id, state);
    }
    return state;
  }

  private publishLink(id: number, agent: AgentState, state: LinkState): void {
    const message = agentLinkMessage(id, agent, state);
    const key = JSON.stringify(message);
    if (key === state.sent) return;
    state.sent = key;
    this.store.broadcast({ ...message });
  }
}

function limitMessage(id: number, info: UsageLimitInfo): AgentLimit {
  return {
    type: 'agentLimit',
    id,
    paused: true,
    reason: info.reason,
    ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
  };
}

// ── Registration (like transcriptParser's progress tracker) ─────

let inboxTracker: InboxTracker | null = null;

export function setInboxTracker(tracker: InboxTracker | null): void {
  inboxTracker = tracker;
}

/** The registered tracker: for the transcript parser, the hook handler and the
 *  connect-time resend. */
export function getInboxTracker(): InboxTracker | null {
  return inboxTracker;
}
