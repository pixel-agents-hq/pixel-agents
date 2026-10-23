/**
 * SignalsHub: the server half of the office's "useful signals" (docs/office/
 * DESIGN.md, phase D). It hears tool starts and ends (hooks, or the transcript
 * for agents without hooks), transcript usage records and the store's own
 * broadcasts, and sends:
 *
 *  - agentTrouble  failed tools in a row (trouble.ts)
 *  - agentLoop     going in circles (loopDetector.ts)
 *  - dailyTokens   today's tokens and estimated spend (tokenMeter.ts)
 *  - noticeBoard   open PRs and issues from `gh` (noticeBoard.ts)
 *  - agentTimeline one agent's recent actions, on request (timeline.ts)
 *
 * Owned by AgentRuntime and registered in registry.ts; timers run only once
 * start() is called (both surfaces call it with the stale check).
 */

import * as os from 'os';
import * as path from 'path';

import type { AgentTimeline, NoticeItem, WorkPhase } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { LAYOUT_FILE_DIR, LOCAL_SESSIONS_PROJECTS_SUBPATH } from '../constants.js';
import { classifyTool } from '../progress/phase.js';
import type { Landed, ProgressTracker } from '../progress/progressTracker.js';
import { repoOf } from '../tasks/taskLedger.js';
import { formatToolStatus } from '../transcriptParser.js';
import { LOOP_CHECK_INTERVAL_MS, noticeBoardEnabled, TOKENS_DIR_NAME } from './constants.js';
import { localDateKey } from './localDay.js';
import { LoopDetector } from './loopDetector.js';
import { type GhRunner, NoticeBoard } from './noticeBoard.js';
import { Timeline } from './timeline.js';
import { TokenBackfill } from './tokenBackfill.js';
import {
  type CountedMessage,
  fromCounted,
  mergeCounted,
  TokenMeter,
  type UsageEntry,
} from './tokenMeter.js';
import { isFailedToolEnd, TroubleTracker } from './trouble.js';

export interface SignalsHubOptions {
  /** Per-day token files: ~/.pixel-agents/tokens by default; null keeps them in memory. */
  tokensDir?: string | null;
  /** The transcripts the token backfill reads (tokenBackfill.ts): ~/.claude/projects
   *  by default when the token files persist, none when they don't; null turns the
   *  backfill off. Tests pass a temp dir. */
  projectsDir?: string | null;
  /** The notice board's `gh` runner; null turns the board off. */
  noticeBoard?: { run?: GhRunner } | null;
  /** Clock (tests). */
  now?: () => number;
}

type Message = Record<string, unknown>;

/** Store broadcasts the hub reads; everything it sends itself is ignored. */
const STATUS_TEXT = {
  active: 'Started working',
  waiting: 'Turn ended',
  permission: 'Needs approval',
  sleep: 'Fell asleep',
  ship: 'Shipping',
} as const;

export class SignalsHub {
  private readonly trouble = new TroubleTracker();
  private readonly loops = new LoopDetector();
  private readonly timeline: Timeline;
  private readonly tokens: TokenMeter;
  private readonly backfill: TokenBackfill | null;
  private readonly board: NoticeBoard | null;
  private readonly now: () => number;
  private readonly status = new Map<number, 'active' | 'waiting'>();
  private readonly phase = new Map<number, WorkPhase>();
  private seen: { date: string; repos: Set<string> } = { date: '', repos: new Set() };
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    private readonly progress: ProgressTracker | null,
    options: SignalsHubOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.timeline = new Timeline(this.now);
    const tokensDir =
      options.tokensDir === undefined
        ? path.join(os.homedir(), LAYOUT_FILE_DIR, TOKENS_DIR_NAME)
        : options.tokensDir;
    this.tokens = new TokenMeter({
      dir: tokensDir,
      now: this.now,
      onChange: (message) => this.send({ ...message }),
    });
    // An in-memory meter (a bare store: tests) never reads the machine's transcripts uninvited.
    const projectsDir =
      options.projectsDir === undefined
        ? tokensDir === null
          ? null
          : path.join(os.homedir(), ...LOCAL_SESSIONS_PROJECTS_SUBPATH)
        : options.projectsDir;
    this.backfill =
      projectsDir === null
        ? null
        : new TokenBackfill({ projectsDir, cacheDir: tokensDir, now: this.now });
    this.board =
      options.noticeBoard === null || !noticeBoardEnabled()
        ? null
        : new NoticeBoard({
            run: options.noticeBoard?.run,
            seenRepos: () => this.seenRepos(),
            onChange: (items) => this.send(boardMessage(items)),
          });
    store.on('broadcast', this.onBroadcast);
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
    progress?.onLanded(this.onLanded);
  }

  /** Is this the hub for that store? */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  /** Start the timers: the stall check, and the notice board's polling. Also
   *  reads today's transcripts once, so the TODAY strip counts the responses
   *  made before the board was up. */
  start(): void {
    if (this.disposed || this.loopTimer) return;
    this.loopTimer = setInterval(() => {
      for (const message of this.loops.check(this.now())) this.send({ ...message });
    }, LOOP_CHECK_INTERVAL_MS);
    this.loopTimer.unref?.();
    this.board?.start();
    if (this.backfill) void this.timeReportUsage([localDateKey(this.now())]);
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.board?.stop();
    this.backfill?.dispose();
    this.tokens.dispose();
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentAdded', this.onAgentAdded);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.progress?.onLanded(null);
    this.disposed = true;
  }

  // ── Inputs ─────────────────────────────────────────────────

  /** A tool started (PreToolUse, or a transcript tool_use for agents without hooks). */
  onToolStart(
    store: AgentStateStore,
    id: number,
    toolName: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): void {
    if (!this.tracks(store)) return;
    const agent = store.get(id);
    if (!agent) return;
    this.noteRepo(agent.directoryName);
    // A tool start is activity: noted before the tool, though the `active`
    // broadcast that says so comes right after it.
    this.markActive(id);
    this.timeline.add(id, 'tool', formatToolStatus(toolName, input), toolId);
    // Shipping (commit, push, PR) is its own line, once per run of ship steps.
    const phase = classifyTool(toolName, input);
    if (phase === 'ship' && this.phase.get(id) !== 'ship') {
      this.timeline.add(id, 'ship', STATUS_TEXT.ship);
    }
    if (phase) this.phase.set(id, phase);
    const loop = this.loops.onToolStart(id, toolName, input, this.now(), !agent.remoteSource);
    if (loop) this.send({ ...loop });
  }

  /** A tool finished, per its hook payload (PostToolUse / PostToolUseFailure). */
  onHookToolEnd(store: AgentStateStore, id: number, event: Record<string, unknown>): void {
    if (!this.tracks(store) || !store.has(id)) return;
    const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
    const failed = isFailedToolEnd(event.hook_event_name, toolName, event.tool_response);
    this.toolEnded(
      id,
      failed,
      typeof event.tool_use_id === 'string' ? event.tool_use_id : undefined,
    );
  }

  /**
   * A transcript record. Usage counts for every transcript (sub-agents' shadow
   * transcripts included: their spend is real), attributed to the repo of the
   * agent it belongs to -- its lead's for a teammate or sub-agent, as the task
   * log credits their work. Tool starts and results count only when
   * `toolsFromTranscript` -- the agent's hooks don't report them.
   */
  onTranscriptRecord(
    store: AgentStateStore,
    id: number,
    record: unknown,
    toolsFromTranscript: boolean,
  ): void {
    if (this.disposed) return;
    this.tokens.record(record, repoForTokens(store, id));
    if (!toolsFromTranscript || !this.tracks(store)) return;
    const r = record as { type?: unknown; message?: { content?: unknown }; content?: unknown };
    const content = r?.message?.content ?? r?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (r.type === 'assistant' && block?.type === 'tool_use') {
        const input =
          typeof block.input === 'object' && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        this.onToolStart(
          store,
          id,
          typeof block.name === 'string' ? block.name : '',
          input,
          typeof block.id === 'string' ? block.id : undefined,
        );
      } else if (r.type === 'user' && block?.type === 'tool_result') {
        this.toolEnded(
          id,
          block.is_error === true,
          typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        );
      }
    }
  }

  // ── Output ─────────────────────────────────────────────────

  /** One agent's timeline (requestTimeline), or null for an agent the store doesn't have. */
  timelineMessage(store: AgentStateStore, id: unknown): AgentTimeline | null {
    if (!this.tracks(store) || typeof id !== 'number' || !store.has(id)) return null;
    return this.timeline.message(id);
  }

  /**
   * Each day's responses with their repos, for the time report
   * (tasks/timeReport.ts): what the meter saw, plus what the transcripts hold
   * (tokenBackfill.ts) -- the two merged by message id. Today's scan is folded
   * into the meter itself, so dailyTokens (the TODAY strip) counts it too.
   * Never rejects; a day with nothing is left out.
   */
  async timeReportUsage(dates: readonly string[]): Promise<Record<string, UsageEntry[]>> {
    const usage: Record<string, UsageEntry[]> = {};
    if (this.disposed) return usage;
    const scanned = this.backfill ? await this.backfill.usageFor(dates) : new Map();
    if (this.disposed) return usage;
    const today = localDateKey(this.now());
    for (const date of dates) {
      const found: ReadonlyMap<string, CountedMessage> | undefined = scanned.get(date);
      if (date === today) {
        if (found) {
          this.tokens.batch(() => {
            for (const [id, counted] of found) this.tokens.absorb(id, fromCounted(counted));
          });
        }
        const todays = this.tokens.usageFor(date);
        if (todays.length > 0) usage[date] = todays;
        continue;
      }
      const merged = new Map<string, CountedMessage>(found ?? []);
      for (const [id, counted] of this.tokens.messagesFor(date)) {
        const scannedToo = merged.get(id);
        merged.set(id, scannedToo ? mergeCounted(scannedToo, counted) : counted);
      }
      if (merged.size > 0) usage[date] = [...merged.values()].map(fromCounted);
    }
    return usage;
  }

  /** What a connecting client is sent: trouble and loops in force, today's tokens, the board. */
  snapshot(): Message[] {
    const messages: Message[] = [];
    for (const m of this.trouble.snapshot()) if (this.store.has(m.id)) messages.push({ ...m });
    for (const m of this.loops.snapshot()) if (this.store.has(m.id)) messages.push({ ...m });
    messages.push({ ...this.tokens.message() });
    if (this.board) messages.push(boardMessage(this.board.current()));
    return messages;
  }

  /** Refresh the notice board now (tests, and the first poll). */
  pollNoticeBoard(): Promise<void> {
    return this.board?.poll() ?? Promise.resolve();
  }

  // ── Internals ──────────────────────────────────────────────

  private markActive(id: number): void {
    this.loops.onActive(id, this.now());
    this.timeline.onActive(id);
    if (this.status.get(id) === 'active') return;
    this.status.set(id, 'active');
    this.timeline.addStatus(id, STATUS_TEXT.active);
  }

  private toolEnded(id: number, failed: boolean, toolId: string | undefined): void {
    if (failed) this.timeline.markFailed(id, toolId);
    const trouble = this.trouble.record(id, failed);
    if (trouble) this.send({ ...trouble });
  }

  private send(message: Message): void {
    if (!this.disposed) this.store.broadcast(message);
  }

  private readonly onBroadcast = (message: Message): void => {
    const id = message.id;
    if (this.disposed || typeof id !== 'number' || !this.store.has(id)) return;
    const now = this.now();
    switch (message.type) {
      case 'agentStatus':
        if (message.status === 'active') {
          this.markActive(id);
        } else {
          this.loops.onWaiting(id, now);
          this.timeline.onWaiting(id);
          if (this.status.get(id) !== 'waiting') {
            this.status.set(id, 'waiting');
            this.timeline.addStatus(id, STATUS_TEXT.waiting);
          }
        }
        return;
      case 'agentToolPermission':
        this.timeline.addStatus(id, STATUS_TEXT.permission);
        return;
      case 'agentSleep':
        if (message.sleeping === true) {
          this.timeline.addStatus(id, STATUS_TEXT.sleep);
          this.status.delete(id);
          const loop = this.loops.onSleep(id, now);
          if (loop) this.send({ ...loop });
        }
        return;
    }
  };

  private readonly onAgentAdded = (_id: number, agent: { directoryName?: string }): void => {
    this.noteRepo(agent.directoryName);
  };

  private readonly onAgentRemoved = (id: number): void => {
    this.trouble.remove(id);
    this.loops.remove(id);
    this.timeline.remove(id);
    this.status.delete(id);
    this.phase.delete(id);
  };

  private readonly onLanded = (id: number, landed: Landed): void => {
    if (this.disposed || !this.store.has(id)) return;
    if (landed.kind === 'push') this.timeline.push(id, landed.repo);
    else this.timeline.pr(id, landed.pr);
  };

  private noteRepo(name: string | undefined): void {
    const date = localDateKey(this.now());
    if (this.seen.date !== date) this.seen = { date, repos: new Set() };
    if (name) this.seen.repos.add(name);
  }

  /** Repo names seen today, current agents' included. */
  private seenRepos(): ReadonlySet<string> {
    for (const agent of this.store.values()) this.noteRepo(agent.directoryName);
    return this.seen.repos;
  }
}

function boardMessage(items: NoticeItem[]): Message {
  return { type: 'noticeBoard', items };
}

/** The repo a transcript's responses count toward: the agent's lead's while the
 *  lead is on the board (a teammate's or sub-agent's spend is its lead's work),
 *  else its own; undefined for an agent the store doesn't have. */
function repoForTokens(store: AgentStateStore, id: number): string | undefined {
  const agent = store.get(id);
  if (!agent) return undefined;
  const lead = agent.leadAgentId !== undefined ? store.get(agent.leadAgentId) : undefined;
  return repoOf(lead ?? agent);
}
