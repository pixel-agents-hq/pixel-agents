// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Directory Suggestions ───────────────────────────────────
/** How much of a session transcript is read to recover the working directory it
 *  records. The cwd sits on the first records, so the head is enough — whole
 *  transcripts run to megabytes and there is one per session on the machine. */
export const DIRECTORY_SUGGESTION_HEAD_BYTES = 8_192;
/** Transcripts tried per session directory before moving on. Every session in
 *  one directory shares a cwd (the directory name encodes it), so the extra
 *  attempts only cover empty or half-written files. */
export const DIRECTORY_SUGGESTION_FILES_PER_SESSION_DIR = 5;
/** Upper bound on suggestions returned, so a long agent history can't flood the
 *  Directory modal on a phone. The newest survive the cut — the list is ordered
 *  by when a session last ran there. */
export const DIRECTORY_SUGGESTION_LIMIT = 10;

// ── Display Truncation + Pixel Agents Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
/** The handshake's token is missing or wrong: the embedded `/ws` Bearer header,
 *  or the `?token=` query on `/terminal/:agentId` (an untokened standalone `/ws`
 *  still connects, unprivileged -- see wsAuth.ts). */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;
/** Terminal socket: the agent has no PTY on this server (never spawned, or
 *  already exited). The route only ever attaches; it cannot start one. */
export const WS_CLOSE_NO_SESSION = 4004;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB

// ── Standalone Embedded Terminal ────────────────────────────
/** PTY module ids tried in order by the loader. @lydell/node-pty ships prebuilt
 *  binaries for all six platform/arch targets as optionalDependencies with no
 *  install scripts; official node-pty has no Linux prebuild and relies on
 *  install scripts that npm >=11.16 gates by default. Keeping a candidate LIST
 *  means anyone who prefers the Microsoft package can just install it.
 *  See docs/design/standalone-terminal.md. */
export const PTY_MODULE_CANDIDATES = ['@lydell/node-pty', 'node-pty'] as const;
/** Loopback hostnames. Used to warn when the server binds off-loopback, and
 *  always part of the privileged-Host allowlist (wsAuth.privilegedHostnames). */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'] as const;
/** Wildcard bind addresses: listen targets, never a name a browser sends as
 *  Host, so binding to one adds nothing to the privileged-Host allowlist. */
export const WILDCARD_HOSTNAMES = ['0.0.0.0', '::'] as const;

/** Scrollback lines the per-session headless-xterm mirror retains. Matches the
 *  browser's TERMINAL_SCROLLBACK_LINES so a reattach replays the same depth the
 *  client would have kept. Bounds the serialized replay snapshot. */
export const TERMINAL_MIRROR_SCROLLBACK_LINES = 5_000;
/** Terminal size used until the browser reports its real geometry. */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
/** TERM value exported into the PTY. */
export const TERMINAL_TERM_NAME = 'xterm-256color';
/** Grace period between SIGHUP and SIGKILL when disposing a PTY. */
export const TERMINAL_KILL_GRACE_MS = 2_000;
/** How long shutdown waits past the SIGKILL escalation for the exits to land. */
export const TERMINAL_SHUTDOWN_SLACK_MS = 1_000;
/** unavailableReason() when the operator opted out with --no-terminal. Shown
 *  verbatim as the disabled + Agent button's tooltip in the browser. */
export const TERMINAL_DISABLED_BY_FLAG_REASON = 'Terminal disabled with --no-terminal.';
/** terminalAvailability reason for an UNPRIVILEGED /ws client (no valid token,
 *  or a Host outside the allowlist): the PTY may work, but this connection may
 *  not open one. Launching an agent starts a shell as the operator, so it is
 *  gated exactly like the hooks toggle (wsAuth.standaloneHandshakeVerdict). */
export const TERMINAL_REQUIRES_TOKEN_REASON =
  'Open the URL the CLI printed (with its ?token=), at localhost or a name passed with --allowed-host, to launch agents from this browser.';
/** directoryRejected reason when the shared config write behind a Directory
 *  save or delete failed. The detail (permissions, disk full, ...) is on the
 *  host's console, where writeConfig logged it. */
export const DIRECTORY_WRITE_FAILED_REASON =
  "Couldn't save the change: writing ~/.pixel-agents/config.json failed (see the host's log).";
/** Standalone persists its server token here (mode 0600, beside server.json) so
 *  the tokened URL a browser bookmarked keeps working across restarts. The
 *  embedded (VS Code) server still mints a fresh token per process. */
export const STANDALONE_TOKEN_FILE_NAME = 'standalone-token';

// ── Workspaces ──────────────────────────────────────────────
/** Machine-wide Workspace list, beside config.json (which readConfig rewrites
 *  without unknown keys and both hosts share). */
export const WORKSPACES_FILE_NAME = 'workspaces.json';
export const WORKSPACES_DIR_MODE = 0o700;
export const WORKSPACES_FILE_MODE = 0o600;
export const DEFAULT_WORKSPACE_NAME = 'Default';
export const WORKSPACE_NAME_MAX_LENGTH = 60;
export const WORKSPACE_DIRECTORY_PATHS_MAX = 200;
export const WORKSPACE_DIRECTORY_PATH_MAX_LENGTH = 4096;
export const WORKSPACE_ID_MAX_LENGTH = 100;
/** How much of a transcript's head is read to find the session's first `cwd`
 *  when an external session is adopted by the file scan. */
export const WORKSPACE_CWD_HEAD_BYTES = 65_536;
/** workspaceRejected reasons. */
export const WORKSPACE_WRITE_FAILED_REASON =
  "Couldn't save the change: writing ~/.pixel-agents/workspaces.json failed (see the host's log).";
export const WORKSPACES_FILE_UNREADABLE_REASON =
  "Couldn't change Workspaces: ~/.pixel-agents/workspaces.json is unreadable or malformed. Fix or delete it, then try again.";

// ── Roles ───────────────────────────────────────────────────
/** Where a Directory keeps its Roles: one `.md` file per Role. One letter away
 *  from `.claude/rules/`, which Claude Code loads into EVERY agent of the folder. */
export const ROLE_CLAUDE_DIR_NAME = '.claude';
export const ROLE_FILES_DIR_NAME = 'roles';
/** A Role id is its file name: ASCII, no separators, ending in `.md`. */
export const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;
export const ROLE_ID_SUFFIX = '.md';
/** Windows device names, refused as a Role id's first dot-separated segment. */
export const ROLE_WINDOWS_RESERVED_NAMES: readonly string[] = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];
/** Directory entries looked at per enumeration, and Roles listed at most. */
export const ROLE_SCAN_MAX_ENTRIES = 200;
export const ROLE_LIST_MAX_ENTRIES = 50;
/** Largest Role file accepted (bytes); reads stop at this + 1. */
export const ROLE_FILE_MAX_BYTES = 64 * 1024;
export const ROLE_DIRECTORY_PATH_MAX_LENGTH = 4096;
export const ROLE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** ~/.pixel-agents/roles/: trust records and launch snapshots, private to the operator. */
export const ROLES_STORAGE_DIR_NAME = 'roles';
export const ROLES_TRUST_FILE_NAME = 'trust.json';
export const ROLES_SNAPSHOTS_DIR_NAME = 'snapshots';
export const ROLES_STORAGE_DIR_MODE = 0o700;
export const ROLES_STORAGE_FILE_MODE = 0o600;
export const ROLES_TRUST_FILE_VERSION = 1;
/** trust.json larger than this is treated as malformed (never parsed). */
export const ROLES_TRUST_FILE_MAX_BYTES = 1024 * 1024;
/** roleRejected reasons: never the Role's content, never a resolved path. */
export const ROLE_UNAVAILABLE_REASON =
  'Roles are only available in the standalone office with the terminal enabled, and not on Windows.';
export const ROLE_VSCODE_UNAVAILABLE_REASON =
  'Roles are not available in the VS Code panel. Launch without a Role, or use the standalone office.';
export const ROLE_INVALID_DIRECTORY_REASON =
  'That Directory is not one of the registered Directories.';
export const ROLE_MISSING_DIRECTORY_REASON = 'Launching with a Role needs a Directory.';
export const ROLE_INVALID_ID_REASON = 'That is not a valid Role name.';
export const ROLE_NOT_LISTED_REASON = 'That Role is not in the Directory any more.';
export const ROLE_UNREADABLE_REASON = "That Role file couldn't be read as a plain file.";
export const ROLE_TOO_LARGE_REASON = `That Role file is larger than ${ROLE_FILE_MAX_BYTES / 1024} KiB.`;
export const ROLE_BAD_CONTENT_REASON =
  'That Role file contains characters that are not allowed (invalid UTF-8, a byte-order mark, control, tag or bidirectional-override characters).';
export const ROLE_INVALID_HASH_REASON = 'The confirmation did not carry a valid content hash.';
export const ROLE_CHANGED_REASON =
  'The Role file changed after it was reviewed. Review it again before confirming.';
export const ROLE_UNTRUSTED_REASON =
  'This Role content has not been confirmed (or it changed since). Review and confirm it again.';
export const ROLE_STORAGE_UNSAFE_REASON =
  '~/.pixel-agents/roles must be a real directory owned by you with mode 0700. Fix or remove it, then try again.';
export const ROLE_TRUST_UNREADABLE_REASON =
  '~/.pixel-agents/roles/trust.json is unreadable or malformed, so it was left untouched. Fix or delete it, then try again.';
export const ROLE_WRITE_FAILED_REASON =
  "Couldn't write the Role's trust record or launch copy (see the host's log).";
export const ROLE_LAUNCH_FAILED_REASON = "The agent couldn't be started (see the host's log).";
export const ROLE_LIST_FAILED_REASON = "The Directory's Roles couldn't be read.";
export const ROLE_REQUEST_FAILED_REASON = "The Role request failed (see the host's log).";

// ── Knowledge Base storage ──────────────────────────────────
/** ~/.pixel-agents/kb/: one private directory per Workspace (POSIX only). */
export const KB_STORAGE_DIR_NAME = 'kb';
export const KB_SETTINGS_FILE_NAME = 'settings.json';
export const KB_INDEX_FILE_NAME = 'index.json';
export const KB_BLOBS_DIR_NAME = 'blobs';
export const KB_PROPOSALS_DIR_NAME = 'proposals';
export const KB_AUDIT_FILE_NAME = 'audit.jsonl';
export const KB_BLOB_SUFFIX = '.md';
export const KB_PROPOSAL_SUFFIX = '.json';
/** Every KB id (non-default Workspace, entry, proposal, blob): a lowercase UUID v4. */
export const KB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const KB_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Rotated audit files: audit.<firstSeq>-<lastSeq>.jsonl. */
export const KB_AUDIT_ROTATED_PATTERN = /^audit\.([0-9]{1,15})-([0-9]{1,15})\.jsonl$/;
/** Writer lock generations: kb/.lock.<n>, a positive decimal of at most 12 digits. */
export const KB_LOCK_NAME_PATTERN = /^\.lock\.([1-9][0-9]{0,11})$/;
export const KB_LOCK_NAME_PREFIX = '.lock.';
/** A lock symlink's target: kbwriter:<pid>:<instance>:<startedAt>. */
export const KB_LOCK_TARGET_PATTERN =
  /^kbwriter:([1-9][0-9]{0,9}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9]{1,15})$/;
export const KB_LOCK_TARGET_PREFIX = 'kbwriter';
/** Lock acquisition re-reads the directory at most this many times on EEXIST. */
export const KB_LOCK_MAX_ATTEMPTS = 3;
export const KB_FILE_FORMAT_VERSION = 1;
export const KB_ENTRY_CONTENT_MAX_BYTES = 64 * 1024;
export const KB_TOTAL_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
export const KB_ENTRIES_MAX = 500;
export const KB_PENDING_PROPOSALS_MAX = 100;
export const KB_PENDING_PER_PROPOSER_MAX = 20;
export const KB_TERMINAL_PROPOSALS_MAX = 1000;
export const KB_PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A create larger than this (UTF-8 bytes) is high impact, like every replace and delete. */
export const KB_HIGH_IMPACT_CREATE_BYTES = 16384;
export const KB_TITLE_MAX_CODE_POINTS = 120;
export const KB_INDEX_FILE_MAX_BYTES = 1024 * 1024;
export const KB_SETTINGS_FILE_MAX_BYTES = 4 * 1024;
export const KB_PROPOSAL_FILE_MAX_BYTES = 160 * 1024;
export const KB_AUDIT_LINE_MAX_BYTES = 4 * 1024;
export const KB_AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;
export const KB_AUDIT_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
/** The audit chain tail is found in this much of the file's end (+1 byte). */
export const KB_AUDIT_TAIL_WINDOW_BYTES = 16 * 1024;
export const KB_APPLIED_RING_MAX = 200;
/** Proposer fields: instance and sessionId are non-empty strings up to this long. */
export const KB_PROPOSER_STRING_MAX_LENGTH = 128;
/** Orphan blobs and staging files younger than this are never swept. */
export const KB_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
/** voidWorkspaceProposals reasons (recorded as audit reason codes). */
export const KB_VOID_REASONS: readonly string[] = ['workspace_removed', 'agent_removed'];
/** KB failure reasons: never a title, a content, or a resolved path. */
export const KB_INVALID_ID_REASON = 'That Knowledge Base id is not valid.';
export const KB_INVALID_INPUT_REASON = 'The request has a missing or malformed field.';
export const KB_INVALID_TITLE_REASON =
  'The title must be 1-120 characters of visible text on one line, without control, invisible or bidirectional characters.';
export const KB_INVALID_CONTENT_REASON =
  'The content contains characters that are not allowed (invalid UTF-8, a byte-order mark, control, tag or bidirectional-override characters).';
export const KB_NOT_FOUND_REASON = 'No such Knowledge Base entry or proposal.';
export const KB_TITLE_CONFLICT_REASON = 'Another Knowledge Base entry already has that title.';
export const KB_STALE_REASON = 'The entry changed after the proposal was made.';
export const KB_STATE_REASON = 'The proposal is not in a state that allows this decision.';
export const KB_DIGEST_MISMATCH_REASON = 'The proposal is not the one that was reviewed.';
export const KB_TOO_LARGE_REASON = 'The content or a Knowledge Base file is larger than allowed.';
export const KB_QUOTA_PENDING_REASON = 'Too many proposals are waiting for a decision.';
export const KB_QUOTA_PROPOSER_REASON = 'This agent has too many proposals waiting for a decision.';
export const KB_QUOTA_ENTRIES_REASON =
  'The Knowledge Base already holds the maximum number of entries.';
export const KB_QUOTA_TOTAL_REASON = 'The Knowledge Base would exceed its total size.';
export const KB_QUOTA_AUDIT_REASON =
  'The Knowledge Base audit log is full; changes are refused until it is archived by hand.';
export const KB_LOCKED_REASON =
  'Another Pixel Agents server is writing this Knowledge Base (or its writer lock needs manual attention).';
export const KB_TAMPERED_REASON =
  'A Knowledge Base file does not match its recorded integrity data, so it was not used.';
export const KB_CORRUPT_INDEX_REASON =
  'The Knowledge Base index is unreadable or malformed, so it was left untouched.';
export const KB_CORRUPT_SETTINGS_REASON =
  'The Knowledge Base settings file is unreadable or malformed, so it was left untouched.';
export const KB_UNSAFE_STORAGE_REASON =
  '~/.pixel-agents/kb must be real directories owned by you with mode 0700 (and is not available on Windows).';
export const KB_IO_REASON = "The Knowledge Base could not be read or written (see the host's log).";

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;
