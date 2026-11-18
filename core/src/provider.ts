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

/**
 * Where a session runs now, as one signal tells it: a hook payload (every
 * event names its working folder and transcript) or a transcript record that
 * says the session moved (Claude: EnterWorktree / ExitWorktree write
 * `relocated` and `worktree-state`). The runtime follows the agent when this
 * differs from where it was (server/src/agentMoves.ts).
 */
export interface SessionWhereabouts {
  /** The folder the session runs in now. */
  cwd?: string;
  /** Where the CLI says the transcript is now. A hint only: it is followed
   *  when that file exists (Claude's `-p` sessions name a file never made). */
  transcriptPath?: string;
  /** The branch checked out there, when the signal names it. */
  branch?: string;
}

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
  /** One line on what it shows: the Intro's checkbox text. Absent = a
   *  generic line naming the CLI (the server's `usageBridgeStatus`). */
  readonly summary?: string;
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

/**
 * How a CLI packages instructions it loads for one session as a skill. The
 * office names the skill (`plugin` is the namespace, `id` the skill) and
 * writes its words; the folder layout, the file format and how the skill is
 * invoked are the CLI's.
 */
export interface SkillPackaging {
  /** The message that makes a session follow the skill (Claude: its slash
   *  command, `/<plugin>:<id>`). */
  command(plugin: string, id: string): string;
  /** How the CLI names the skill to the agent running it (Claude:
   *  `<plugin>:<id>`). */
  skillName(plugin: string, id: string): string;
  /** Write the skill under `dir` in the CLI's own layout, over any files of
   *  the same names already there (others are left alone), and return the
   *  folder a launch names in `pluginDirs`. Throws when it can't be written. */
  write(
    dir: string,
    skill: {
      plugin: string;
      pluginDescription: string;
      id: string;
      description: string;
      title: string;
      instructions: string;
    },
  ): string;
}

/**
 * How a CLI keeps a repo's git worktrees and files their sessions. The office
 * puts the Worktrees it creates in the same folder, so the CLI files their
 * sessions with the repo's own, and reads the CLI's own worktrees from there.
 * Shared code knows neither the folder, nor how a session dir is named, nor
 * the CLI's lock and settings: it asks this, through
 * server/src/worktreeLocation.ts, which picks the one provider whose
 * convention the office follows (where a folder's session dirs are is still
 * the provider's `getSessionDirs`).
 */
export interface WorktreeConvention {
  /** The worktrees folder under a repo root, as path segments (Claude:
   *  `.claude`, `worktrees`). */
  readonly folder: readonly string[];
  /** The name of the session dir of the folder at `folderPath`, whether or
   *  not either exists. */
  sessionDirName(folderPath: string): string;
  /** The worktree whose sessions the session dir named `dirName` holds, when
   *  it is a worktree of the repo whose own session dir is named
   *  `repoDirName`: the worktree folder's name as the dir name spells it
   *  (which may have lost characters), else null. */
  worktreeOfSessionDir(dirName: string, repoDirName: string): string | null;
  /** The process a git worktree lock of this CLI's names, read from the
   *  lock's reason (Claude: `claude session <name> (pid N …)`), or null when
   *  the reason names none. Whether that process still runs is the caller's
   *  check. Undefined = this CLI locks no worktrees. */
  lockHolder?(lockReason: string): number | null;
  /** Folders (relative to the repo root) a new Worktree of `repoPath` links to
   *  the main checkout instead of copying, as this CLI's own settings list them
   *  (Claude: `worktree.symlinkDirectories`, user and project scope).
   *  Undefined = this CLI has no such setting. */
  symlinkDirectories?(repoPath: string): string[];
}

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
    /** Where the session runs as of this event (every event, not only
     *  sessionStart): how the runtime notices an agent that moved. */
    where?: SessionWhereabouts;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline labels the ask, the summary is its one line
   *  beside the Intro's checkbox, the disclosure its full terms behind "Read more" (what is written, what data moves,
   *  how to undo). The method, the headline and the disclosure are required — a provider that installs anything must
   *  state its terms, and the gate ships them verbatim so no client copy can drift; the summary is optional (absent =
   *  the headline stands in for it). */
  consentDisclosure(): { headline: string; summary?: string; disclosure: string };
  /** Whether the provider's CLI is installed on this machine (the Intro's "get Claude Code" step shows only when it
   *  isn't). Absent = assumed installed. */
  isCliInstalled?(): boolean;

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
  /** The session's new whereabouts when a transcript record says it moved
   *  (Claude: `relocated`, `worktree-state`), else null. What the runtime
   *  follows an agent by without hooks. Undefined = no such records. */
  sessionMoveFromRecord?(record: unknown): SessionWhereabouts | null;
  /** How this CLI loads a set of instructions for one session (Claude: a
   *  plugin folder holding a skill). Undefined = it has no such thing: the
   *  session is sent to the instructions another way (the tutorial's brief
   *  comes from its MCP tool). */
  readonly skills?: SkillPackaging;
  /** The permission mode that lets safe actions through without a prompt and
   *  still asks before risky ones (Claude: `auto`), one of `permissionModes`.
   *  Undefined = the CLI's default mode is used where this one is wanted (the
   *  tutorial's Guide, which never launches with prompts skipped). */
  readonly autoPermissionMode?: string;
  /** This CLI's name for its most capable model, as its launch takes it
   *  (Claude: the alias `opus`). Undefined = the user's default model. */
  readonly mostCapableModel?: string;
  /** The terminal input modes this CLI's TUI runs with: whether it turns
   *  bracketed paste on, and whether its cursor keys are in application mode.
   *  For a surface that types into an agent's terminal without being able to
   *  read it (VS Code). Undefined = plain: neither. */
  readonly terminalInputModes?: { bracketedPaste: boolean; applicationCursorKeys: boolean };
  /** The contents of the file a launch's `mcpConfig` names, in this CLI's own
   *  format, for one MCP server reached over HTTP with a bearer token (Claude:
   *  the `--mcp-config` JSON). Undefined = this CLI takes no such file, and its
   *  agents are offered no MCP. */
  mcpConfigFile?(server: { name: string; url: string; token: string }): string;
  /** Build CLI launch command for +Agent button. `resume`: continue the
   *  existing session `sessionId` (its transcript) instead of starting one. Only
   *  a provider with `conversationTitle` is asked to resume (the conversation
   *  list is its), and it must honour `resume`: ignoring it would start a new
   *  session under the old id. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: {
      bypassPermissions?: boolean;
      resume?: boolean;
      /** A file holding the MCP servers this launch gets (the Pixel Office MCP's
       *  per-agent config). A path, never the config itself: it carries a token,
       *  and a command line is readable by every process on the machine. Its
       *  contents are this provider's own (`mcpConfigFile`). */
      mcpConfig?: string;
      /** The model to run (the CLI's own model names and aliases). */
      model?: string;
      /** One of `permissionModes`, other than `bypassPermissionMode` (that one
       *  is `bypassPermissions`). */
      permissionMode?: string;
      /** The session's first message, passed as the CLI's starting prompt (an
       *  argv entry: never typed into the terminal, never a shell string). */
      prompt?: string;
      /** Tools of an MCP server this launch may call without a permission
       *  prompt (the tutorial agent's read-only Pixel Office MCP tools). The
       *  provider spells them its CLI's way; every other tool still asks. */
      preapprovedMcpTools?: { server: string; tools: readonly string[] };
      /** Plugin folders this session alone loads (the tutorial's onboarding
       *  skill); nothing is installed. */
      pluginDirs?: readonly string[];
    },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** True for an environment variable a running session of this CLI exports to
   *  the processes under it as a marker of THAT session (its id, its socket, a
   *  "you are a child session" flag). An agent the office launches is a session
   *  of its own: when the office itself runs inside a session (a server started
   *  from one), these must not reach it — Claude Code, seeing an inherited child
   *  marker, turns transcript saving off, and the office reads transcripts.
   *  Settings the user exported (models, API config) are not markers.
   *  Undefined = this CLI marks nothing. */
  isInheritedSessionEnv?(name: string): boolean;
  /** The permission modes a launch may ask for (the CLI's own names), the
   *  default included. Undefined = this CLI takes no permission mode. */
  readonly permissionModes?: readonly string[];
  /** The one of `permissionModes` that skips every permission prompt: allowed
   *  only while the office's skip-permissions setting is on, and launched as
   *  `bypassPermissions` rather than as a mode. */
  readonly bypassPermissionMode?: string;
  /** A session transcript's title as the CLI shows it (a user rename wins over
   *  the generated one), or undefined when it has none. Read by the sidebar's
   *  recent conversations; undefined = this provider names no conversations
   *  (and is never asked to resume one). */
  conversationTitle?(transcriptPath: string): string | undefined;
  /** How this CLI keeps a repo's git worktrees and files their sessions:
   *  the folder, the session dirs' naming, its lock and its symlink setting.
   *  Undefined = this CLI has no worktrees of its own. */
  readonly worktrees?: WorktreeConvention;

  /** Optional account-usage reporting (the office's usage bars). */
  readonly usageBridge?: UsageBridge;

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider
