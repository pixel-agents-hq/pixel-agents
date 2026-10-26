/**
 * Provider abstraction for AI agent tools.
 *
 * Only HookProvider ships today (Claude Code). Transcript-polling and push-based
 * provider types will be added when a real second provider (Codex, Goose,
 * Discord, etc.) actually lands, derived from that provider's needs rather than
 * speculation.
 */

import type { TeamProvider } from './teamProvider.js';

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      /** True when the tool was spawned to run in the background (e.g. Claude's
       *  `run_in_background` on Agent/Task). Handlers use this to suppress ghost
       *  sub-agent characters for teammate spawns. */
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Claude's Notification(idle_prompt)) rather than simply finishing
       *  its response (Stop). Drives the "Waiting for input" vs "Done" label.
       *  Absent/false = the agent finished its turn (Done). */
      awaitingInput?: boolean;
      /** Context snapshot finalized by this turn, for providers that PUSH it on
       *  the turn-end event instead of keeping a transcript the server can poll
       *  (Hermes: its per-turn token totals + resolved window). Absent = this
       *  turn said nothing about context; the gauge keeps its previous value. */
      usage?: {
        /** Tokens the finalized turn's last request carried (prompt side + what
         *  the model wrote). Matches the transcript-derived figure's semantics. */
        contextTokens: number;
        /** The window that context counts against, provider-resolved. Absent =
         *  the server keeps its estimate and widens it if the context exceeds. */
        maxContextTokens?: number;
      };
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      /** 'idle' = subagent is idle and ready for more work; 'completed' = subagent
       *  reported its task done. Some providers emit only one; both route to the
       *  same handler but with different downstream cleanup. */
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  /**
   * A pending permission was resolved by the human at the provider's own
   * surface (Hermes' `post_approval_response`). The handler reverses
   * permissionRequest's bubble. Claude never emits it — its JSONL polling
   * broadcasts `agentToolPermissionClear` instead — so this exists for
   * push-only providers that have no file watcher to retire the bubble.
   */
  | { kind: 'permissionResolved' }
  | {
      kind: 'sessionStart';
      source?: string;
      /** For external-session adoption: path to the session's transcript file
       *  (if the provider uses one). Undefined for providers without transcripts. */
      transcriptPath?: string;
      /** Working directory the session was started in. Used to match pending
       *  external sessions against known Directories. */
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Whether this provider's CLI is present on THIS machine right now. Surfaces
   *  use it to stay silent about tools the user does not have: the webviewReady
   *  consent loop skips unavailable providers (no status, no first-run ask),
   *  and the capabilities broadcast lists only available ones so Settings rows
   *  cannot offer a nonexistent integration. SYNC by contract — the handshake
   *  message order is a wire invariant and cannot wait on a promise; a
   *  provider needing an expensive probe (spawn, network) caches its answer.
   *  Undefined = always available (the conservative default: a provider
   *  without this member behaves exactly as before the member existed). A
   *  THROWING probe counts as available: a flaky check must never silently
   *  hide an integration the user already uses. */
  isAvailable?(): boolean;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline titles the ask, the disclosure is its body
   *  (what is written, what data moves, how to undo; paragraphs split on blank lines). Required, not optional — a
   *  provider that installs anything must state its terms, and the gate ships these verbatim so no client copy can
   *  drift. */
  consentDisclosure(): { headline: string; disclosure: string };

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" character animation instead of "typing".
   *  The provider classifies tools as read-like or write-like; the webview renders
   *  the animation. Allows new providers to override without webview edits. */
  readonly readingTools: ReadonlySet<string>;
  /** Terminal name prefix used when launching this CLI. Used by the extension to
   *  match VS Code terminals to agents for heuristic adoption. */
  readonly terminalNamePrefix?: string;

  /** Context window, in tokens, for a model id this CLI reports in its
   *  transcripts. Transcripts state token usage but never the limit it counts
   *  against, so only the provider can say — and getting it wrong is visible:
   *  the office renders usage/window as a context gauge over every character.
   *  Return undefined for an unrecognized model; the runtime then keeps its
   *  previous estimate and widens it if a context ever exceeds it. */
  contextWindowForModel?(model: string | undefined): number | undefined;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started
   *  (across all workspaces). Used by global session discovery / "Watch All
   *  Sessions". Each returned dir contains subdirs whose entries are session
   *  transcript files. Undefined = this provider doesn't support global scan. */
  getAllSessionRoots?(): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;

  /** Structured per-session activity records ("recently worked-in" directories)
   *  for the Directory modal, for providers whose session store is NOT a
   *  transcript directory the file collectors can walk (Hermes keeps SQLite, not
   *  per-directory JSONL). Most-recent-first is NOT required — the collector
   *  sorts by `lastActiveMs` and merges across providers. Undefined = the
   *  provider has no structured store (file-fallback roots cover it, or nothing). */
  directorySuggestions?(): { cwd: string; lastActiveMs: number }[];

  /** Pathless sessions: a provider whose sessions can legitimately carry
   *  NEITHER a transcript path NOR a working directory (Hermes' desktop
   *  gateway rows store `cwd = NULL` and there is no per-session file) must
   *  have a sessionStart without either STAGED as a pending external session
   *  anyway — the ordinary `transcriptPath || cwd` staging gate exists to
   *  filter a file provider's transient sessions, and without this opt-in it
   *  would silently swallow the store scanner's birth two-beat, leaving the
   *  session invisible forever. Undefined/false keeps the gate closed
   *  (Claude's transient-session filter stays exactly as before). */
  readonly stagesPathlessSessions?: boolean;

  /** Session-store scanner: the non-file twin of the heuristic mode above.
   *  A provider whose sessions live somewhere `fs.watch` cannot poll (a SQLite
   *  store plus a process registry) may expose this so the runtime gets the
   *  same three capabilities:
   *    - hook-less adoption of live sessions (synthetic sessionStart + activity
   *      replay through `emit`, i.e. exactly the hook pipeline's front door),
   *    - liveness reaping (a session the store reports as ended, or whose lease
   *      pid is gone, is finalized even when the CLI died without a goodbye),
   *    - sub-agent correlation the wire does not carry (the store knows
   *      parent↔child; the event envelope often does not).
   *  The scanner drives ONLY transitions it observed since the previous tick —
   *  it is delta-based so hook-delivered sessions are never double-rendered.
   *  Return null when the store cannot be opened on this host (the capability
   *  is then simply absent; nothing else changes). */
  createSessionScanner?(ctx: SessionScannerContext): SessionScanner | null;
  /** Build CLI launch command for +Agent button. `sessionId` is the id the
   *  office generated (Claude honours it via --session-id). Providers whose
   *  session-id format is an upstream contract they mint themselves (Hermes)
   *  may mint their own and return it as `sessionId`: the launcher then
   *  registers THAT id, so hook events for the spawned process route to it. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// ── Session-store scanner (the non-file twin of heuristic mode) ──

/** Everything a provider's session scanner may ask the runtime, and the one
 *  door it may use to speak back. Events are fed as RAW wire-shaped envelopes
 *  through `emit` — they run through that provider's `normalizeHookEvent` and
 *  the full hook pipeline (pending-session adoption, session→agent routing,
 *  event buffering), exactly like a real hook delivery. A scanner therefore
 *  cannot invent a second rendering path: what it emits is what the CLI itself
 *  would have POSTed, or the provider's documented scanner-only wire names. */
export interface SessionScannerContext {
  /** The provider's own id — stamped on every emitted event's routing. */
  readonly providerId: string;
  /** Deliver one raw event envelope into the hook pipeline. */
  emit(event: Record<string, unknown>): void;
  /** Whether the session is already driven by live signals: registered with a
   *  character, pending confirmation, or owned by a known agent. A scanner
   *  skips ADOPTION and activity replay for such sessions (hooks got there
   *  first) but still owns their LIVENESS, which no hook can prove after a
   *  process that died without a goodbye. */
  isSessionLive(sessionId: string): boolean;
  /** Directory-union policy for adoption, mirroring the hook adoption gate:
   *  a session outside a tracked Directory is adopted only while "Watch All
   *  Sessions" is on. */
  isAdoptableDir(cwd: string): boolean;
}

/** Lifecycle handle returned by `HookProvider.createSessionScanner`. The
 *  runtime calls start() once (idempotent) and stop() on dispose. */
export interface SessionScanner {
  start(): void;
  stop(): void;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider
