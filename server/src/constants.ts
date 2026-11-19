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

// ── Background spawns ───────────────────────────────────────
/** A background agent that paused (an interim notice: it stopped to wait on
 *  background work of its own) and has written nothing since is taken as
 *  finished after this long. Claude Code can keep calling every stop interim
 *  (an old Monitor it still counts as running) and then never notify again. */
export const PAUSED_SPAWN_END_MS = 10 * 60_000;
/** How often paused spawns are checked. */
export const PAUSED_SPAWN_CHECK_INTERVAL_MS = 30_000;
/** A paused agent's transcript gets its last records (the stop hook's) a
 *  moment before the notice lands; a write later than this after the notice
 *  means the agent resumed. */
export const PAUSED_SPAWN_WRITE_SLACK_MS = 5_000;

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
  USAGE_API_PREFIX,
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
/** The DEC private modes that pick a mouse encoding, by xterm's encoding
 *  name. The serialize addon restores mouse tracking but not its encoding,
 *  so a replay appends this (the default X10 encoding needs none). */
export const TERMINAL_MOUSE_ENCODING_MODES: Readonly<Record<string, string>> = {
  SGR: '\x1b[?1006h',
  SGR_PIXELS: '\x1b[?1016h',
};
/** Terminal size used until the browser reports its real geometry. */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
/** TERM value exported into the PTY. */
export const TERMINAL_TERM_NAME = 'xterm-256color';
/** LANG exported into the PTY when the server's environment names no locale
 *  (a launchd service has none): without one, macOS tools such as pbcopy
 *  read UTF-8 as Mac Roman, and "í" reaches the clipboard as "√≠". */
export const TERMINAL_DEFAULT_LANG = 'en_US.UTF-8';
/** Grace period between SIGHUP and SIGKILL when disposing a PTY. */
export const TERMINAL_KILL_GRACE_MS = 2_000;
/** How long shutdown waits past the SIGKILL escalation for the exits to land. */
export const TERMINAL_SHUTDOWN_SLACK_MS = 1_000;

// ── Files sent to a terminal (server/src/terminal/fileUploads.ts) ──
/** Where they land unless the user chose a folder: this folder of our own,
 *  under ~/.pixel-agents, which the server keeps from growing (sweepUploads). */
export const UPLOADS_DIRECTORY_NAME = 'uploads';
/** A file in our own uploads folder is deleted this long after it was sent:
 *  days, since an agent holds only its path and a conversation resumed the
 *  next day may read it again. */
export const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Our own uploads folder never holds more than this: past it the oldest
 *  files go first, whatever their age. */
export const UPLOADS_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/** How often a running server sweeps its uploads folder (and once at start). */
export const UPLOAD_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The OS's Downloads folder, under the home directory: one of the places a
 *  sent file's original is looked for. */
export const DOWNLOADS_DIRECTORY_NAME = 'Downloads';
/** Linux: the file under the XDG config directory that says where the
 *  desktop's Downloads folder is (`XDG_DOWNLOAD_DIR`). */
export const XDG_USER_DIRS_FILE_NAME = 'user-dirs.dirs';
/** A saved file's name is cut to this many characters (its extension kept). */
export const UPLOAD_FILE_NAME_MAX_LENGTH = 120;
/** The name of a file that arrived with none usable. */
export const UPLOAD_FALLBACK_FILE_NAME = 'file';
/** Looking for a sent file's original on this machine (terminal/localFile.ts):
 *  how long the check may take before it is given up. */
export const LOCAL_FILE_SEARCH_TIMEOUT_MS = 2_000;
/** A file system and a browser round a modification time differently: this
 *  far apart still counts as the same moment. */
export const LOCAL_FILE_MTIME_TOLERANCE_MS = 1_000;
/** How many numbered names (`photo-2.jpg`, …) are tried for a taken one. */
export const UPLOAD_NAME_ATTEMPTS = 1000;

// ── PTY host (development only: `pixel-agents --pty-host`) ──
/** The host exits after this long with no terminal and no server connected. */
export const PTY_HOST_IDLE_EXIT_MS = 60_000;
/** How long a server waits for a host it just started to accept connections. */
export const PTY_HOST_START_TIMEOUT_MS = 5_000;
/** Between connection attempts while waiting for a host to come up. */
export const PTY_HOST_CONNECT_RETRY_MS = 100;
/** A request the host never answers (a replay) gives up after this long. */
export const PTY_HOST_REQUEST_TIMEOUT_MS = 5_000;
/** The host's bundle, next to dist/cli.js. Not in the npm package: dev only. */
export const PTY_HOST_SCRIPT = 'pty-host.js';
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

// ── ~/.pixel-agents Persistence ────────────────────────────
export const PIXEL_AGENTS_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const JSON_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';

// ── Usage bars (plan rate limits) ───────────────────────────
/** The last usage report per provider, in the persistence dir (shared by both surfaces). */
export const USAGE_LIMITS_FILE_NAME = 'usage-limits.json';
/** An unchanged usage report is still passed on (and saved) once this old, so
 *  the office's "updated N min ago" stays true while a session is open. */
export const USAGE_UNCHANGED_REFRESH_MS = 60_000;

// ── Avatar Customization ────────────────────────────────────
/** The character profiles agents are drawn from, in the persistence dir (shared by both surfaces). */
export const CHARACTER_PROFILES_FILE_NAME = 'characters.json';
/** The custom wardrobe items saved from the pixel editor, beside characters.json. */
export const WARDROBE_ITEMS_FILE_NAME = 'wardrobe-items.json';
/** Inclusive upper bound for a valid agent repeat (which copy of its character
 *  it is; there are never nearly this many agents in an office). Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const MAX_CHARACTER_REPEAT = 1_000;

// ── Recent conversations (the sidebar) ──────────────────────
/** What each conversation's agent wore and where it sat, in the persistence dir. */
export const CONVERSATIONS_FILE_NAME = 'conversations.json';
/** Most conversations whose look is remembered (the newest are kept). */
export const CONVERSATION_LOOKS_MAX = 500;
/** Conversations the sidebar lists per Directory to begin with (running ones included), newest first. */
export const CONVERSATIONS_PER_DIRECTORY = 5;
/** Most conversations a Directory's "Show more" or a search may ask for. */
export const CONVERSATIONS_LIMIT_MAX = 2_000;
/** Most Directories a requestConversations may set a limit for. */
export const CONVERSATIONS_LIMIT_ENTRIES_MAX = 200;
/** A search query longer than this is cut. */
export const CONVERSATION_QUERY_MAX_CHARS = 200;
/** A running conversation the coding agent hasn't titled yet. */
export const NEW_CONVERSATION_TITLE = 'New conversation';

/** Most agent ids a saved card order keeps. The order is pruned to live agents
 *  on every save, so this only bounds a hand-edited or hostile payload. */
export const MAX_CARD_ORDER_LENGTH = 1_000;

// ── Worktrees (server/src/worktree*.ts) ─────────────────────
/** The registry of the Worktrees Pixel Agents created, in the persistence dir
 *  (machine-wide, like config.json). Being listed here is the only proof a
 *  worktree is ours to manage. */
export const WORKTREES_FILE_NAME = 'worktrees.json';
/** Whose character each Worktree's row wears (the session of the agent it
 *  belongs to, by folder), in the persistence dir. Both kinds of Worktree. */
export const WORKTREE_AGENTS_FILE_NAME = 'worktree-agents.json';
/** Most Worktrees whose agent is remembered (the newest are kept). */
export const WORKTREE_AGENTS_MAX = 500;
/** How long the scanners' reading of the host's Directories (worktree
 *  attribution) is reused before config.json is read again. This process's
 *  own Directory changes drop it at once; this only bounds how long another
 *  process's edit takes to be seen. */
export const ATTRIBUTION_DIRECTORIES_TTL_MS = 10_000;
/** Where a Directory's Worktrees live under its repo root when no bundled
 *  provider declares a worktrees folder of its own. With one that does (Claude
 *  Code today), they live in the provider's (`HookProvider.worktrees`,
 *  read by worktreeLocation.ts), so the CLI files their sessions with the
 *  Directory's. */
export const FALLBACK_WORKTREES_FOLDER: readonly string[] = ['.pixel-agents', 'worktrees'];
/** The repo file listing the gitignored files a new Worktree gets a copy of
 *  (gitignore syntax; the convention Claude Code, Conductor and Codex share). */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
/** Generated names tried before a create gives up on finding a free one. */
export const WORKTREE_NAME_ATTEMPTS = 25;
/** Base `fresh`: how long the fetch from origin may take before the Worktree
 *  falls back to the main checkout's current commit. */
export const WORKTREE_FETCH_TIMEOUT_MS = 15_000;
/** The most branches the new-worktree modal lists (newest commit first). */
export const WORKTREE_OPTIONS_MAX_BRANCHES = 500;
/** Any other git call (all local): a hung one fails the create instead of
 *  hanging the launch. */
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
/** The reason `git worktree lock` records on every Worktree of ours, for as
 *  long as it lasts (running, kept or waiting on a decision): the lock keeps
 *  `git worktree prune` and other tools' cleanup off it, and the reason says
 *  where it is removed from. */
export const WORKTREE_LOCK_REASON = 'Pixel Agents worktree: remove it from the Worktrees list';
/** The trailer that marks a Save & remove commit (so a later restore can tell
 *  it apart from the agent's own commits). */
export const WORKTREE_SAVED_TRAILER = 'Pixel-Agents-Saved: true';
/** The Save & remove commit's subject. */
export const WORKTREE_SAVE_SUBJECT = 'Save uncommitted changes';
/** The Save commit's identity when the user has none configured: a save must
 *  never fail just because git doesn't know who is committing. */
export const WORKTREE_FALLBACK_NAME = 'Pixel Agents';
export const WORKTREE_FALLBACK_EMAIL = 'pixel-agents@localhost';
/** Where what a half-done `git worktree remove` left is moved before it is
 *  deleted: `<worktrees folder>/<prefix><name>-<ms>` (a dot name, so no
 *  Worktree is ever made there). */
export const WORKTREE_REMOVING_PREFIX = '.removing-';
/** Commits of the base read when looking for a squash merge of a whole
 *  branch: a bound on the work, newest first. */
export const WORKTREE_SQUASH_SCAN_COMMITS = 500;
/** The startup sweep: a kept Worktree folder nobody touched for this long
 *  needs a decision again (the user forgot it). */
export const WORKTREE_KEPT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** The startup sweep waits this long after the server is up, so the first
 *  office's handshake (and the agents restored or reattached for it) goes
 *  first; git work runs in the background after it. */
export const WORKTREE_SWEEP_DELAY_MS = 3000;
/** How long a worktree's branch, read from its HEAD, is trusted before it is
 *  read again (adoption asks once per session; the scanner never re-reads). */
export const WORKTREE_BRANCH_CACHE_MS = 5000;
/** Shutting down: how long the server waits for Worktree git work already
 *  under way (a retirement, the sweep) before it exits anyway. */
export const WORKTREE_SHUTDOWN_WAIT_MS = 10_000;
/** An agent that moved (EnterWorktree / ExitWorktree) whose transcript isn't
 *  where the CLI said yet: the move and the signal race, so look again this
 *  often, this many times, before leaving it to the scanners. */
export const AGENT_MOVE_RETRY_INTERVAL_MS = 500;
export const AGENT_MOVE_RETRY_ATTEMPTS = 10;

/** How long an answer given at the card's × (save / keep / discard) waits for
 *  its agent to exit; past it the answer is dropped and the Worktree's leave
 *  asks again, so a stale answer never applies to some later leave. */
export const WORKTREE_CLOSE_CHOICE_TTL_MS = 30_000;

// ── Pixel Office MCP (server/src/mcp/) ──────────────────────
/** The MCP's id: what Claude Code's /mcp list and tool names show
 *  (`mcp__pixel-office__list_agents`). */
export const OFFICE_MCP_SERVER_NAME = 'pixel-office';
/** The route the MCP is served on (Streamable HTTP, stateless). */
export const OFFICE_MCP_PATH = '/mcp';
/** Folder under ~/.pixel-agents holding one folder per running server, each
 *  with one 0600 `--mcp-config` file per agent it launched. */
export const OFFICE_MCP_CONFIG_DIR = 'mcp';
/** Request body cap for /mcp (a layout edit batch can be larger than a hook). */
export const OFFICE_MCP_MAX_BODY_SIZE = 1_048_576; // 1MB
/** Bytes of randomness in an agent's MCP token. */
export const OFFICE_MCP_TOKEN_BYTES = 32;
/** What a changing tool answers while the MCP is read-only. */
export const OFFICE_MCP_READ_ONLY_REASON =
  'The Pixel Office MCP is read-only in Pixel Agents settings: listing and reading work, changes are refused. Ask the user to turn read-only off in Settings if this change is needed.';

// ── Character art (server/src/characterArt.ts) ──────────────
/** Screen pixels per sprite pixel in a character preview PNG (whole number, so the
 *  pixel art stays crisp): a 16x32 frame becomes 64x128. */
export const CHARACTER_PREVIEW_SCALE = 4;
/** Where the build puts the wardrobe art, under dist/ (esbuild.js copyWardrobeArt). */
export const WARDROBE_ART_DIST_DIR = 'assets/wardrobe';
