/**
 * Provider abstraction for AI agent tools.
 *
 * Only HookProvider ships today (Claude Code). Transcript-polling and push-based
 * provider types will be added when a real second provider (Codex, Goose,
 * Discord, etc.) actually lands, derived from that provider's needs rather than
 * speculation.
 */

import type { UsageWindow } from './messages.js';
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
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | {
      kind: 'subagentEnd';
      parentToolId: string;
      toolId: string;
      /** The stopped sub-agent's own transcript, when the CLI names it: tells
       *  WHICH of a lead's in-process teammates finished. */
      agentTranscriptPath?: string;
    }
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

// ── Account usage (plan rate limits) ──────────────────────────

/** The account's plan limits as one report states them (windows on the wire
 *  type, `UsageWindow`). Each window may be absent on its own. */
export interface ReportedUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

/** One session's context as the CLI itself measures it (Claude: the status
 *  line's `context_window`), which the office's gauge prefers over its own
 *  transcript estimate. */
export interface ReportedContext {
  sessionId: string;
  /** Share of the window in use, 0-100. */
  usedPercentage: number;
  /** The session's window, in tokens. */
  windowTokens: number;
}

/**
 * How a provider reports the account's plan usage to the server: a small
 * script the CLI runs, installed into the CLI's own settings (Claude: the
 * status line, which is the only place Claude Code hands out its rate
 * limits). The script POSTs to `/api/usage/:providerId`; the provider turns
 * the body into a ReportedUsage. Install is always an explicit user choice.
 */
export interface UsageBridge {
  /** What installing writes, what data moves, how to undo it — shown before
   *  the user confirms (paragraphs split on blank lines). */
  readonly disclosure: string;
  /** Whether the bridge is installed in the CLI's settings. */
  isInstalled(): boolean;
  /** Copy the bridge script from `packageRoot` (the extension / npm package
   *  root, holding dist/hooks/) and install it. Throws, before any write, when
   *  it cannot be installed without rewriting something the user wrote. */
  install(packageRoot: string): Promise<void>;
  /** Restore the CLI's settings to what they were. Throws when it cannot. */
  uninstall(): Promise<void>;
  /** Re-copy an installed bridge's script (startup: a new version ships a new
   *  script). No-op when not installed. */
  refreshScript(packageRoot: string): void;
  /** Validate a report POSTed by the script; null for anything malformed. */
  normalizeReport(raw: unknown): ReportedUsage | null;
  /** The reporting session's context from the same POST; null when it
   *  carries none (before the session's first response) or is malformed. */
  normalizeContext(raw: unknown): ReportedContext | null;
}

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

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
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean; resume?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** A session transcript's title as the CLI shows it (a user rename wins over
   *  the generated one), or undefined when it has none. Read by the sidebar's
   *  recent conversations; undefined = this provider names no conversations. */
  conversationTitle?(transcriptPath: string): string | undefined;

  /** Optional account-usage reporting (the office's usage bars). */
  readonly usageBridge?: UsageBridge;

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider
