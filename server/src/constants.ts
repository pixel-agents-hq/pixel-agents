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
/** Remove an external agent whose JSONL has not been written for this long (no SessionEnd needed) */
export const EXTERNAL_IDLE_REMOVE_MS = 6 * 60 * 60 * 1000; // 6 hours
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
/** Embedded mode: the `/ws` handshake's Bearer header is missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the client-message channel. */
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
/** Loopback hostnames. Used to warn when the server binds off-loopback. */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'] as const;

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
/** directoryRejected reason when the shared config write behind a Directory
 *  save or delete failed. The detail (permissions, disk full, ...) is on the
 *  host's console, where writeConfig logged it. */
export const DIRECTORY_WRITE_FAILED_REASON =
  "Couldn't save the change: writing ~/.pixel-agents/config.json failed (see the host's log).";

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
// ── Agent capabilities (per-agent identity tokens) ──────────
/** Env var a capability-holding PTY agent receives its token in. Never
 *  inherited from the server's own environment (ptySessionManager strips it). */
export const CAPABILITY_ENV_NAME = 'PIXEL_AGENTS_CAPABILITY';
export const CAPABILITY_TOKEN_PREFIX = 'pxa_kb_';
/** Random bytes per token, encoded as base64url after the prefix. */
export const CAPABILITY_TOKEN_BYTES = 32;
/** Exact token shape: the prefix plus 43 base64url characters (32 bytes). */
export const CAPABILITY_TOKEN_PATTERN = /^pxa_kb_[A-Za-z0-9_-]{43}$/;
/** Authorization header scheme a capability may be presented under. */
export const CAPABILITY_BEARER_PREFIX = 'Bearer ';

// ── Workspace curators ──────────────────────────────────────
/** curatorRejected reasons: fixed strings, never an agent's or a file's content. */
export const CURATOR_INVALID_REASON = 'That curator request is not valid.';
export const CURATOR_EXISTS_REASON = 'That Workspace already has a curator.';
export const CURATOR_NOT_ELIGIBLE_REASON =
  'That agent cannot be the curator of this Workspace (it is not an agent this office launched in that Workspace).';
export const CURATOR_UNAVAILABLE_REASON = 'Curators are only available in the standalone office.';

// ── Curator bindings（KB Writer 綁定 (workspaceId, Directory)，重啟後自動恢復） ──
/** ~/.pixel-agents/ 底下的私有檔（0600）；不放 workspaces.json，也不在線上 Workspace schema 裡。 */
export const CURATOR_BINDINGS_FILE_NAME = 'curator-bindings.json';
export const CURATOR_BINDINGS_FILE_VERSION = 1;
/** 超過這個大小的檔案整份不採信（沒有任何綁定，不自動恢復）。 */
export const CURATOR_BINDINGS_FILE_MAX_BYTES = 1024 * 1024;
/** 超過這個筆數的檔案整份不採信。 */
export const CURATOR_BINDINGS_MAX_ENTRIES = 256;
/** 指定成功但綁定寫不進磁碟：以 workspaceRejected 只回給操作者。 */
export const CURATOR_BINDING_SAVE_FAILED_REASON =
  '已指定 KB Writer，但無法儲存，重啟後不會自動恢復';
/** 解除成功（記憶體已清除並廣播）但磁碟上的綁定沒刪掉：以 workspaceRejected 只回給操作者。 */
export const CURATOR_BINDING_REMOVE_FAILED_REASON =
  '已解除 KB Writer，但無法儲存，重啟後可能自動恢復';

// ── Task dispatch (curator -> agent, MCP `dispatch_task`, standalone only) ──
/** The /mcp endpoint the stdio shim forwards JSON-RPC to. Standalone only. */
export const TASK_DISPATCH_MCP_PATH = '/mcp';
/** Route-level body limit for /mcp: a 4000-character task, JSON-escaped, fits. */
export const TASK_DISPATCH_MCP_MAX_REQUEST_BYTES = 32_768;
/** Non-secret env var the launcher sets to the launching server's own port. */
export const TASK_DISPATCH_PORT_ENV_NAME = 'PIXEL_AGENTS_PORT';
/** File name of the bundled stdio MCP shim under dist/hooks/. */
export const TASK_DISPATCH_SHIM_FILE_NAME = 'pixel-agents-mcp.js';
/** The key the shim is registered under in the `--mcp-config` JSON. */
export const TASK_DISPATCH_MCP_SERVER_NAME = 'pixel-agents';
/** The one tool the shim exposes. Never added to any allowed-tools list. */
export const TASK_DISPATCH_TOOL_NAME = 'dispatch_task';
/** MCP protocol revisions the endpoint answers `initialize` with (newest first). */
export const TASK_DISPATCH_MCP_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
/** JSON-RPC 2.0 error codes the /mcp endpoint and the shim answer with. */
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_PARSE_ERROR = -32700;
/** Maximum task length in UTF-16 code units, after CRLF -> LF normalization. */
export const TASK_DISPATCH_MAX_TASK_CHARS = 4_000;
/** No dispatch into a target whose terminal received operator input this recently. */
export const TASK_DISPATCH_OPERATOR_QUIET_MS = 10_000;
/** Rate limits: at most N attempts per caller / N writes per target per window. */
export const TASK_DISPATCH_RATE_WINDOW_MS = 60_000;
export const TASK_DISPATCH_RATE_MAX_PER_CALLER = 6;
export const TASK_DISPATCH_RATE_MAX_PER_TARGET = 3;
/** A dispatch whose mirror flush has not completed by then is refused. */
export const TASK_DISPATCH_FLUSH_DEADLINE_MS = 2_000;
/** How long the shim waits for one /mcp answer before replying with an error. */
export const TASK_DISPATCH_SHIM_TIMEOUT_MS = 10_000;
/** The shim drops a /mcp answer larger than this (the server's are tiny). */
export const TASK_DISPATCH_SHIM_MAX_RESPONSE_BYTES = 65_536;
/** The shim's fixed JSON-RPC error texts: it never echoes a server body or a header. */
export const TASK_DISPATCH_SHIM_NOT_CONFIGURED_MESSAGE =
  'Pixel Agents task dispatch is not available in this session';
export const TASK_DISPATCH_SHIM_UNREACHABLE_MESSAGE = 'Pixel Agents server did not answer';
export const TASK_DISPATCH_SHIM_REFUSED_MESSAGE = 'Pixel Agents server refused the request';
export const TASK_DISPATCH_SHIM_PARSE_ERROR_MESSAGE = 'Parse error';
/** Bracketed-paste markers the server synthesizes around a dispatched task. */
export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';
/** Control-character ranges a dispatched task may not contain (LF excepted). */
export const LINE_FEED = 0x0a;
export const C0_CONTROL_MAX = 0x1f;
export const DEL_CONTROL = 0x7f;
export const C1_CONTROL_MIN = 0x80;
export const C1_CONTROL_MAX = 0x9f;
/** The fixed first line of every dispatched task (the caller's agent id after it). */
export const TASK_DISPATCH_PREFIX_LABEL = 'Task from Workspace KB Writer';
/** The ONE answer to every refused dispatch: it never says which rule failed. */
export const TASK_DISPATCH_DENIED_MESSAGE = 'Task not dispatched.';
/** Fixed bodies for the /mcp endpoint's HTTP-level refusals. */
export const TASK_DISPATCH_FORBIDDEN_BODY = 'forbidden';
export const TASK_DISPATCH_UNAUTHORIZED_BODY = 'unauthorized';

// ── Write guard（阻擋式裁決通道，standalone 限定） ─────────
/** hook 向伺服器詢問裁決的端點。與 HOOK_API_PREFIX 分開，既有的事件轉發路由不變。 */
export const WRITE_GUARD_API_PATH = '/api/guard/verdict';
/** 裁決請求的 body 上限。請求只含路徑、command 等欄位（F9），不含檔案內容；
 *  超過上限時 hook 不送出，視同伺服器未回答（只有受保護路徑才 fail-closed）。 */
export const WRITE_GUARD_MAX_REQUEST_BYTES = MAX_HOOK_BODY_SIZE;
/** hook 讀取裁決回應的上限；伺服器只回很短的 JSON，超過視同沒有回答。 */
export const WRITE_GUARD_MAX_RESPONSE_BYTES = 4_096;
/**
 * hook 端裁決的總截止時間（毫秒）。必須明顯短於安裝器寫入的 hook 逾時
 * （claudeHookInstaller.ts makeHookEntry 的 `timeout: 5`，單位秒），
 * 讓 hook 在被 Claude Code 砍掉之前就能自己做出 fail-closed 決定（F2、F13）。
 */
export const WRITE_GUARD_HOOK_DEADLINE_MS = 1_200;
/** 受保護根目錄清單與已知 session 清單（每台 standalone 伺服器一份）所在的
 *  子目錄（位於 SERVER_JSON_DIR 之下），檔名與 registry 相同：`<pid>-<port>.json`。 */
export const WRITE_GUARD_LISTS_DIR = 'guard';
/** 清單檔格式版本。hook 只採認同版本的清單，其他一律視為沒有清單。 */
export const WRITE_GUARD_LIST_VERSION = 1;
/** 已知 session 清單的後備重算間隔。session id 的變更大多透過事件立即反映；
 *  這個間隔只補上不經 AgentRuntime.registerAgent 的變更路徑（例如 heuristic 的
 *  /clear 重新指派）。只在內容改變時才寫檔。 */
export const WRITE_GUARD_LIST_REFRESH_INTERVAL_MS = 1_000;
/** agentGuardStatus 的 hook 鏈檢查間隔（讀 settings.json 與腳本檔）。檢查結果快取，
 *  裁決路徑從不碰檔案系統（F13）；hooks 狀態變更時另外立即重查。 */
export const GUARD_STATUS_CHAIN_CHECK_INTERVAL_MS = 5_000;
/** 裁決端點只接受從 loopback 對端來的請求（縱深防禦，沿用 S3b /mcp 的作法）。 */
export const WRITE_GUARD_LOOPBACK_PEERS: readonly string[] = [
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
];
/** 標示「轉送過的請求」的標頭；裁決端點一律拒絕。 */
export const WRITE_GUARD_FORWARDING_HEADERS: readonly string[] = ['forwarded', 'via'];
export const WRITE_GUARD_FORWARDING_HEADER_PREFIX = 'x-forwarded-';
/** 裁決端點的錯誤回應 body：固定字串。 */
export const WRITE_GUARD_FORBIDDEN_BODY = 'forbidden';
export const WRITE_GUARD_UNAUTHORIZED_BODY = 'unauthorized';
export const WRITE_GUARD_BAD_REQUEST_BODY = 'bad request';

/** 伺服器回 deny 時的規則識別碼（hook 依此套用固定範本，不轉送伺服器的任何文字）。 */
export const WRITE_GUARD_RULE_PROTECTED_PATH = 'protected-path';
/** hook 端 fail-closed：已知 standalone session 對受保護路徑寫入，伺服器卻沒有回答。 */
export const WRITE_GUARD_RULE_UNREACHABLE = 'guard-unreachable';
/** 工作空間 KB 區（<根目錄>/.note/）：寫入者不是該工作空間的 curator。 */
export const WRITE_GUARD_RULE_KB_WORKSPACE = 'kb-workspace';
/** 工作空間 KB 區：該工作空間已設根目錄，但還沒有任命 curator（KB Writer）。 */
export const WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER = 'kb-workspace-no-writer';
/** 個人 KB 區（<Agent Directory>/.note/）：路徑不在寫入者自己的識別鍵之下。 */
export const WRITE_GUARD_RULE_KB_PERSONAL = 'kb-personal';
/** 寫入類工具的目標路徑抽不到或無法正規化（F7）。 */
export const WRITE_GUARD_RULE_KB_PATH_UNRESOLVED = 'kb-path-unresolved';
/** F17 拒絕清單：~/.pixel-agents/、~/.claude/settings*.json、<Agent Directory>/.claude/。 */
export const WRITE_GUARD_RULE_PROTECTED_CONFIG = 'protected-config';
/** P3：角色缺少某操作類別時的規則識別碼。 */
export const WRITE_GUARD_RULE_ROLE_READ = 'role-read';
export const WRITE_GUARD_RULE_ROLE_EDIT = 'role-edit';
export const WRITE_GUARD_RULE_ROLE_DELETE = 'role-delete';
/** Bash 的寫入目標無法判斷（指令過長、巢狀過深、目標過多、路徑無法正規化）。 */
export const WRITE_GUARD_RULE_BASH_UNRESOLVED = 'kb-bash-unresolved';
/** hook 端裁決流程本身發生例外：已知 session 且 KB 規則啟用時，寫入類工具 fail-closed。 */
export const WRITE_GUARD_RULE_GUARD_ERROR = 'guard-error';
/** guard-error 時 fail-closed 的工具（寫入類檔案工具與 Bash）；讀取類與其他工具放行。 */
export const WRITE_GUARD_ERROR_FAIL_CLOSED_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
];

/**
 * 寫入類檔案工具（Claude Code 的工具名稱）。hook 端與伺服器端共用：抽不到路徑時
 * KB 規則 deny（F7）。假設（未實測，P0 #5）：NotebookEdit 的路徑欄位可能是
 * `notebook_path`；欄位抽取兩個名稱都收，抽不到就 deny。
 */
export const WRITE_GUARD_FILE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'NotebookEdit'];
/** 路徑正規化時最多跟隨的 symlink 次數（與常見作業系統的 MAXSYMLINKS 同量級）；
 *  超過視為無法判斷（fail-closed）。 */
export const WRITE_GUARD_MAX_SYMLINK_HOPS = 40;

// ── KB 寫入阻擋（P2） ───────────────────────────────────────
/** 工作空間 KB 與個人 KB 共用的目錄名稱。 */
export const KB_NOTE_DIR_NAME = '.note';
/**
 * 未設角色的 Agent 在個人 KB 中的識別鍵。必須是 S1b 角色檔名白名單
 * （ROLE_ID_PATTERN：英數開頭、以 `.md` 結尾）產生不出來的字串：
 * `_` 開頭且不以 `.md` 結尾，大小寫折疊後也一樣，因此不會與任何角色檔撞名。
 */
export const KB_PERSONAL_RESERVED_KEY = '_default';
/** F17：Claude Code 設定檔的檔名規則（~/.claude/settings*.json）。 */
export const KB_CLAUDE_SETTINGS_FILE_PATTERN = /^settings.*\.json$/i;
/** F17：Claude Code 使用者層設定目錄名稱（位於 HOME 之下）。 */
export const KB_CLAUDE_HOME_DIR_NAME = '.claude';

// ── KB 唯讀瀏覽（listKbFiles／readKbFile） ───────────────────
/** relPath 的字元數上限（與 asyncapi 的 KbRelPath maxLength 一致）。 */
export const KB_BROWSE_REL_PATH_MAX_LENGTH = 1024;
/** relPath 的段數上限；列舉也只往下走到這個深度（與 asyncapi 的 KbRelPath 一致）。 */
export const KB_BROWSE_MAX_DEPTH = 8;
/** 單一路徑段的 UTF-8 位元組上限（常見檔案系統的檔名上限）。 */
export const KB_BROWSE_SEGMENT_MAX_BYTES = 255;
/** 單一 KB 檔案可讀取的大小上限，沿用 KB 條目內容的上限。 */
export const KB_BROWSE_FILE_MAX_BYTES = KB_ENTRY_CONTENT_MAX_BYTES;
/** 可列出、可讀取的副檔名（小寫、完全比對）：只有純文字筆記。 */
export const KB_BROWSE_ALLOWED_EXTENSIONS: readonly string[] = ['.md', '.txt'];
/** 一次列舉最多回傳的檔案數。 */
export const KB_BROWSE_LIST_MAX_FILES = 500;
/** 一次列舉最多檢視的目錄項目總數（所有層合計）。 */
export const KB_BROWSE_SCAN_MAX_ENTRIES = 5000;
/** 單一目錄最多檢視的目錄項目數。 */
export const KB_BROWSE_DIR_MAX_ENTRIES = 1000;
/** 每個連線同時處理中的 KB 瀏覽請求上限；超過即以 unavailable 拒絕。 */
export const KB_BROWSE_MAX_IN_FLIGHT = 2;

/** setWorkspaceRoot 的 workspaceRejected 理由（固定字串）。 */
export const WORKSPACE_ROOT_INVALID_ID_REASON = 'That Workspace no longer exists.';
export const WORKSPACE_ROOT_NOT_ABSOLUTE_REASON =
  'The Workspace root must be an absolute path to an existing directory.';
export const WORKSPACE_ROOT_NOT_DIRECTORY_REASON =
  'The Workspace root must be an existing directory.';
/** 權限角色值不合格（setWorkspacePermissionRoles 的 workspaceRejected、帶角色啟動的
 *  roleRejected 共用的固定字串）。 */
export const PERMISSION_ROLES_INVALID_REASON =
  'Permission roles must be null or a list of distinct roles from R, E and D.';
export const WORKSPACE_ROOT_OVERLAP_REASON =
  "The Workspace KB (<root>/.note/) would be the same as, or nested with, an agent Directory's personal KB (<Directory>/.note/). Choose another root.";

export const WORKSPACE_ROOT_LOCKED_REASON =
  'The Workspace KB (<root>/.note/) already has content, so its root can no longer be changed or cleared. Empty the KB folder first.';
export const WORKSPACE_ROOT_WORKSPACE_OVERLAP_REASON =
  "The Workspace KB (<root>/.note/) would be the same as, or nested with, another Workspace's KB. Each Workspace needs its own root.";

/**
 * 拒絕訊息的固定範本（F16）：原因、理由、建議三段。只會插入該 Agent 自己送出的
 * 路徑，絕不插入 curator 身分、其他 Agent 的路徑或任何可命名的字串。
 * 未知的規則識別碼一律套用 WRITE_GUARD_DENY_GENERIC。
 */
export interface WriteGuardDenyTemplate {
  reason: string;
  rationale: string;
  suggestion: string;
}
/** P3 的固定範本（權限角色、Bash 目標無法判斷）。併入 WRITE_GUARD_DENY_TEMPLATES（F16）。 */
export const WRITE_GUARD_ROLE_DENY_TEMPLATES: Readonly<Record<string, WriteGuardDenyTemplate>> = {
  [WRITE_GUARD_RULE_ROLE_READ]: {
    reason:
      "This tool call reads files, and this agent's permission roles do not include Read (R).",
    rationale:
      'Each agent may only perform the kinds of operations its permission roles allow: R to read, E to edit, D to delete.',
    suggestion: 'Ask the user to grant this agent the Read (R) role, or to perform this step.',
  },
  [WRITE_GUARD_RULE_ROLE_EDIT]: {
    reason:
      "This tool call edits files or runs a command that may change files, and this agent's permission roles do not include Edit (E).",
    rationale:
      'Each agent may only perform the kinds of operations its permission roles allow: R to read, E to edit, D to delete. Commands Pixel Agents cannot classify count as edits.',
    suggestion: 'Ask the user to grant this agent the Edit (E) role, or to perform this step.',
  },
  [WRITE_GUARD_RULE_ROLE_DELETE]: {
    reason:
      "This command deletes files, and this agent's permission roles do not include Delete (D).",
    rationale:
      'Each agent may only perform the kinds of operations its permission roles allow: R to read, E to edit, D to delete.',
    suggestion: 'Ask the user to grant this agent the Delete (D) role, or to perform this step.',
  },
  [WRITE_GUARD_RULE_BASH_UNRESOLVED]: {
    reason: 'Where this shell command writes could not be fully determined.',
    rationale:
      'While Knowledge Base rules are on, a command whose write targets cannot be checked (too long, too deeply nested, too many targets, or a path that cannot be resolved) is refused rather than allowed.',
    suggestion:
      'Split the command into shorter, simpler commands with plain paths, or use the Write and Edit tools.',
  },
};
export const WRITE_GUARD_DENY_TEMPLATES: Readonly<Record<string, WriteGuardDenyTemplate>> = {
  ...WRITE_GUARD_ROLE_DENY_TEMPLATES,
  [WRITE_GUARD_RULE_GUARD_ERROR]: {
    reason: 'Pixel Agents could not check this write because its local check failed.',
    rationale:
      'While Knowledge Base rules are on, a write that cannot be checked is refused rather than allowed.',
    suggestion: 'Retry the step; if it keeps failing, ask the user to make the change.',
  },
  [WRITE_GUARD_RULE_PROTECTED_PATH]: {
    reason: 'This write targets a path Pixel Agents protects for this agent.',
    rationale:
      'Protected paths (such as a Knowledge Base) may only be written by the agent assigned to them.',
    suggestion:
      'Do not write this path directly. Tell the user what should be recorded, so the assigned writer can make the change.',
  },
  [WRITE_GUARD_RULE_UNREACHABLE]: {
    reason:
      'This write targets a protected path, and the Pixel Agents server did not answer in time.',
    rationale:
      'Without an answer the write cannot be checked, so writes to protected paths are refused rather than allowed.',
    suggestion:
      'Retry once the Pixel Agents server is running, or ask the user to make the change.',
  },
  [WRITE_GUARD_RULE_KB_WORKSPACE]: {
    reason: "This write targets the Workspace Knowledge Base (the Workspace root's .note/ folder).",
    rationale: "Only the Workspace's KB Writer may write the Workspace Knowledge Base.",
    suggestion:
      'Do not write this path directly. The Knowledge Base is maintained only by the KB Writer; tell the user what should be recorded so they can hand it to the KB Writer.',
  },
  [WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER]: {
    reason: "This write targets the Workspace Knowledge Base (the Workspace root's .note/ folder).",
    rationale:
      'Only the Workspace KB Writer may write it, and this Workspace has no KB Writer assigned yet.',
    suggestion:
      'Ask the user to assign a KB Writer for this Workspace, and tell the user what should be recorded.',
  },
  [WRITE_GUARD_RULE_KB_PERSONAL]: {
    reason:
      "This write targets a personal Knowledge Base folder (.note/) outside this agent's own area.",
    rationale:
      'In a personal Knowledge Base each Role writes only its own subfolder: .note/<Role file name>/, or .note/_default/ for an agent launched without a Role.',
    suggestion: 'Write under your own subfolder instead, or ask the user to make this change.',
  },
  [WRITE_GUARD_RULE_KB_PATH_UNRESOLVED]: {
    reason: 'The target path of this file write could not be determined.',
    rationale:
      'While Knowledge Base rules are on, a file write whose target cannot be checked is refused rather than allowed.',
    suggestion: 'Retry with an absolute file path.',
  },
  [WRITE_GUARD_RULE_PROTECTED_CONFIG]: {
    reason: 'This write targets Pixel Agents or Claude Code configuration.',
    rationale:
      "Agents may not change ~/.pixel-agents/, ~/.claude/settings*.json or their Directory's .claude/ folder, which hold the rules they run under.",
    suggestion: 'Ask the user to make this change.',
  },
};
export const WRITE_GUARD_DENY_GENERIC: WriteGuardDenyTemplate = {
  reason: 'Pixel Agents refused this tool call.',
  rationale: 'A Pixel Agents rule for this agent does not allow it.',
  suggestion: 'Ask the user how to proceed.',
};
/** 拒絕訊息中路徑的長度上限（字元）；超過時截斷，避免把超長輸入回灌給模型。 */
export const WRITE_GUARD_DENY_PATH_MAX_LENGTH = 512;

// ── Bash 解析（P3，F10） ────────────────────────────────────
/** hook 端解析 Bash 指令的上限（UTF-8 位元組）。超過時不解析：指令視為無法分類
 *  （需要 edit），寫入目標視為無法判斷（KB 規則啟用時 deny）。 */
export const WRITE_GUARD_BASH_MAX_PARSE_BYTES = 1024 * 1024;
/** `$( )`、反引號、子殼層的巢狀上限；超過時其後內容不分類（需要 edit 與 delete，
 *  且寫入目標視為無法判斷）。也防止遞迴把堆疊用盡。 */
export const WRITE_GUARD_BASH_MAX_NESTING = 16;
/** 一個指令字串最多收集的寫入目標與路徑片段（各自計算）；超過視為無法判斷。 */
export const WRITE_GUARD_BASH_MAX_TARGETS = 256;
/** 同一指令字串內 `cd` 造成的可能工作目錄組合上限；超過視為無法判斷。 */
export const WRITE_GUARD_BASH_MAX_DIR_CHAINS = 8;
/** 重導向到這些目標不算寫入（P3 補充決定 4）。 */
export const WRITE_GUARD_BASH_NON_WRITE_TARGETS: readonly string[] = ['/dev/null'];
/** Bash 分析的確定性工作量預算（lexer 讀過的字元與迴圈、指令數、路徑片段數的總和）。
 *  用完時視為無法解析（read、edit、delete，寫入目標無法判斷）。約對應 150 KB 的一般指令，
 *  讓病態輸入（很長的 word、大量運算子、很長的黏著選項）在固定的工作量內結束。 */
export const WRITE_GUARD_BASH_MAX_WORK = 150_000;
/** hook 端本地解析（含路徑正規化）的時鐘上限（毫秒）；超過時放棄並視為無法解析。
 *  是工作量預算之外的最後防線，明顯短於 hook 的裁決截止時間與 hook 逾時。 */
export const WRITE_GUARD_BASH_LOCAL_DEADLINE_MS = 400;
/** 拒絕訊息中指令名稱片段的長度上限（字元）。 */
export const WRITE_GUARD_DENY_FRAGMENT_MAX_LENGTH = 64;

// ── 權限角色（P3，R／E／D） ─────────────────────────────────
/** 權限角色：三個獨立開關（集合，不是階層），依此順序存放。 */
export const PERMISSION_ROLES = ['R', 'E', 'D'] as const;
/** 需要 read（R）的工具；Write、Edit、NotebookEdit（WRITE_GUARD_FILE_WRITE_TOOLS）需要 edit（E）。
 *  其他工具（Agent、Task、MCP、TodoWrite、WebFetch 等）第一階段不受角色限制。 */
export const WRITE_GUARD_READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];
export const WRITE_GUARD_BASH_TOOL = 'Bash';

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
