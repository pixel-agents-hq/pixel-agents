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

// ── Local Session List (sleeping chibis, standalone only) ───
/** How often the open-session list (`claude agents --json`) is read. */
export const LOCAL_SESSIONS_POLL_MS = 15_000;
/** An idle session whose last activity is older than this is drawn asleep. */
export const SLEEP_AFTER_MS = 10 * 60 * 1000;
/** A session-list-adopted agent whose session is missing from this many
 *  successful listings in a row ended without a SessionEnd, and is removed. */
export const LOCAL_SESSIONS_MISSING_POLLS_TO_REMOVE = 2;
/** Kill a hung `claude agents --json` after this long. */
export const LOCAL_SESSIONS_LIST_TIMEOUT_MS = 10_000;
/** Cap on the listing's stdout; past it the run fails rather than grows. */
export const LOCAL_SESSIONS_LIST_MAX_BUFFER = 2 * 1024 * 1024;
/** Arguments that make Claude Code print its open sessions as JSON. */
export const LOCAL_SESSIONS_LIST_ARGS = ['agents', '--json'] as const;
/** Executable that lists the sessions, found on PATH (run with execFile, never a shell). */
export const LOCAL_SESSIONS_BIN_WIN32 = 'claude.exe';
export const LOCAL_SESSIONS_BIN_POSIX = 'claude';
/** Environment variable naming a different executable to list the sessions with. */
export const LOCAL_SESSIONS_BIN_ENV = 'PIXEL_AGENTS_CLAUDE_BIN';
/** Environment variable that turns the session list off (standalone): set it to
 *  one of LOCAL_SESSIONS_OFF_VALUES. Test harnesses whose `claude` is a mock
 *  (or must never run the real one) set it. */
export const LOCAL_SESSIONS_ENABLED_ENV = 'PIXEL_AGENTS_SESSION_LIST';
export const LOCAL_SESSIONS_OFF_VALUES = ['0', 'false', 'off', 'no'] as const;
/** Where, under the home directory, the listed sessions' transcripts live
 *  (one <encoded cwd>/ dir per project, one <sessionId>.jsonl per session). */
export const LOCAL_SESSIONS_PROJECTS_SUBPATH = ['.claude', 'projects'] as const;
/** The session list's `kind` for a session someone is at the keyboard of. Any
 *  other listed kind is a background session (a compact remote-worker tile). */
export const LOCAL_SESSIONS_INTERACTIVE_KIND = 'interactive';
/** A local session adopted from its hooks that no successful session listing
 *  shows within this long is headless (`claude -p`, a routine): background. */
export const HEADLESS_SESSION_GRACE_MS = 30_000;

// ── Task Titles ─────────────────────────────────────────────
/** How much of a transcript's tail is searched for its newest `ai-title`
 *  record on adoption or restore. Transcripts run to many MB; never read whole. */
export const TITLE_SEED_TAIL_BYTES = 256 * 1024;
/** When the tail has no title, how much of the head is searched instead. */
export const TITLE_SEED_HEAD_BYTES = 256 * 1024;
/** A task title longer than this is cut, ellipsis included. */
export const TASK_TITLE_MAX_LENGTH = 80;

// ── Phone Alerts (ntfy) ─────────────────────────────────────
/** ~/.pixel-agents/<this>: { ntfyTopic, ntfyServer?, waitMinutes? }. Absent = off. */
export const ALERTS_FILE_NAME = 'alerts.json';
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
/** Minutes an agent waits on the user before its phone alert goes out. */
export const DEFAULT_ALERTS_WAIT_MINUTES = 15;
/** An ntfy topic is the only secret: a plain token, long enough not to guess. */
export const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** How often waiting agents are checked against the alert threshold. */
export const ALERTS_CHECK_INTERVAL_MS = 30_000;
/** Abandon an alert POST after this long. */
export const ALERTS_POST_TIMEOUT_MS = 10_000;
/** ntfy notification headers (ASCII only: they are HTTP header values). */
export const ALERTS_NOTIFICATION_TITLE = 'Claude session waiting';
export const ALERTS_NOTIFICATION_TAGS = 'hourglass';
/** Names a waiting agent in an alert when it has no repo name. */
export const ALERTS_UNNAMED_AGENT = 'Claude session';

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
/** An MCP tool's status line ("Using Playwright: browser run code unsafe") is
 *  cut to this many characters, ellipsis included. */
export const MCP_TOOL_STATUS_MAX_LENGTH = 48;

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

// ── Subscription usage meter (usage/usageMeter.ts) ──────────
/** Bearer-authenticated ingress for the status line script's usage reports. */
export const USAGE_API_PATH = '/api/usage';
/** The last usage report, under ~/.pixel-agents, so a restarted server still
 *  shows the meter before Claude Code's next status line refresh. */
export const USAGE_FILE_NAME = 'usage.json';
/** How long the status line script waits on each server before giving up. */
export const USAGE_POST_TIMEOUT_MS = 1000;
/** A remote (relay-ingested) agent silent this long is removed: a sleeping
 *  laptop or a killed cloud VM never sends SessionEnd. */
export const REMOTE_AGENT_TTL_MS = 3 * 60 * 60 * 1000;
export const REMOTE_EXPIRY_CHECK_INTERVAL_MS = 60_000;

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

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';

// ── Work Progress (stage track + done-today strip) ──────────
/** A classified tool this long after the agent's previous one starts a fresh
 *  EXPLORE · BUILD · TEST · SHIP cycle: the earlier work was another task. */
export const PROGRESS_CYCLE_GAP_MS = 30 * 60 * 1000;
/** Subdirectory of ~/.pixel-agents holding one <YYYY-MM-DD>.json of daily totals per local day. */
export const DAILY_STATS_DIR_NAME = 'daily';
/** Daily totals change on every command; they are written at most this often
 *  (and flushed on dispose and at midnight). */
export const DAILY_STATS_SAVE_DEBOUNCE_MS = 2_000;
/** Title of a PR whose `gh pr create` passed no --title (e.g. --fill). */
export const DEFAULT_PR_TITLE = 'PR';

// ── Manager: task log + daily report (server/src/tasks/) ────
/** Subdirectory of ~/.pixel-agents holding one <YYYY-MM-DD>.json task log per local day. */
export const TASKS_DIR_NAME = 'tasks';
/** The task log changes on every command; it is written at most this often
 *  (and flushed on dispose and at midnight). */
export const TASKS_SAVE_DEBOUNCE_MS = 2_000;
/** After a restart, an open task whose session no agent has picked back up
 *  within this long is closed as done: that session ended while we were down. */
export const TASK_ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** Title of a task whose session has no `ai-title` yet: `Untitled · <repo>`. */
export const UNTITLED_TASK_TITLE = 'Untitled';
/** The `machine` of a task that ran on this machine (remote ones carry their source label). */
export const LOCAL_TASK_MACHINE = 'local';
/** Subdirectory of ~/.pixel-agents: the Manager's working dir (claude's cwd for
 *  the report run). Sessions there are the Manager's own and never become tasks. */
export const MANAGER_DIR_NAME = 'manager';
/** Subdirectory of ~/.pixel-agents holding one <YYYY-MM-DD>.json report per day. */
export const REPORTS_DIR_NAME = 'reports';
/** Longest range (days, both ends inclusive) a requestTimeReport may ask for: a
 *  month. Each day is a task file and a token file read, so the cap bounds the work. */
export const TIME_REPORT_MAX_DAYS = 31;
/** In REPORTS_DIR_NAME: { lastScheduledDate } -- the 19:00 run fires once per day across restarts. */
export const REPORT_SCHEDULE_FILE_NAME = 'scheduled.json';
/** Local hour the daily report is written at. */
export const MANAGER_REPORT_HOUR = 19;
/** How often the clock is checked against MANAGER_REPORT_HOUR. */
export const MANAGER_REPORT_CHECK_INTERVAL_MS = 60_000;
/** Kill a `claude -p` report run after this long (the template is written
 *  instead). The work notes make it a long read and a long write. */
export const MANAGER_CLAUDE_TIMEOUT_MS = 300_000;
/** Cap on the report run's stdout; past it the run fails rather than grows. */
export const MANAGER_CLAUDE_MAX_BUFFER = 1024 * 1024;
/** `claude -p` with no tools and nothing saved: the task log arrives on stdin.
 *  Never --bare: it skips the subscription (OAuth) login the run relies on. */
export const MANAGER_CLAUDE_ARGS = [
  '-p',
  '--tools',
  '',
  '--no-session-persistence',
  '--output-format',
  'text',
] as const;
/** Environment variable that turns the Manager's report runs off (set it to one
 *  of LOCAL_SESSIONS_OFF_VALUES): no 19:00 run, and "Write report now" writes
 *  the template without running claude. Test harnesses set it. */
export const MANAGER_ENABLED_ENV = 'PIXEL_AGENTS_MANAGER';
/** An open task with at least this many active minutes and no PR or push is
 *  flagged under "Stuck or failing". */
export const MANAGER_STUCK_ACTIVE_MINUTES = 60;
/** Who the daily report is written to. */
export const MANAGER_REPORT_ADDRESSEE = 'Ansh';
/** The report's overview (the part the dashboard shows first) stays under this many words. */
export const MANAGER_REPORT_MAX_WORDS = 250;
/** Line the report run puts between the overview and the per-repo details. */
export const MANAGER_REPORT_DETAILS_MARKER = '===DETAILS===';
/** Cap on the task log JSON handed to the report run; past it the oldest notes go first. */
export const MANAGER_REPORT_MAX_INPUT_CHARS = 120_000;

// ── Work notes (tasks/workNotes.ts): what a task actually did ─
export const WORK_NOTE_MAX_ASKS = 15;
export const WORK_NOTE_ASK_CHARS = 400;
export const WORK_NOTE_MAX_OUTCOMES = 12;
export const WORK_NOTE_OUTCOME_CHARS = 1200;
export const WORK_NOTE_MAX_TODOS = 30;
export const WORK_NOTE_TODO_CHARS = 160;
export const WORK_NOTE_MAX_COMMITS = 150;
export const WORK_NOTE_COMMIT_CHARS = 160;
/** Most of a transcript kept for one task's time window (the rest of the window is left out). */
export const WORK_NOTES_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
export const WORK_NOTES_GIT_TIMEOUT_MS = 10_000;

// ── Notion (tasks/notionConnector.ts): a page per repo, newest day first ─
/** In ~/.pixel-agents: { pageUrl, repos } -- where the report goes in Notion.
 *  Absent: it is never sent there. */
export const NOTION_CONFIG_FILE_NAME = 'notion.json';
/** Set to one of LOCAL_SESSIONS_OFF_VALUES to never publish, whatever the file says. */
export const NOTION_ENABLED_ENV = 'PIXEL_AGENTS_NOTION';
/** The only tools the courier run may use (the claude.ai Notion connector's). */
export const NOTION_CONNECTOR_TOOLS = ['create-pages', 'update-page', 'fetch'] as const;
/** Kill one repo's courier run after this long. */
export const NOTION_CONNECTOR_TIMEOUT_MS = 300_000;

// ── Ansh's brain (ansh/anshBrain.ts) ─────────────────────────
/** Subdirectory of ~/.pixel-agents holding the brain's state.json (on/off,
 *  today's count, recent thoughts) and claude's working dir for its runs. */
export const ANSH_DIR_NAME = 'ansh';
export const ANSH_STATE_FILE_NAME = 'state.json';
/** How often the office is looked at for something worth a thought. A look
 *  that finds nothing new costs nothing: claude runs only on a change. */
export const ANSH_CHECK_INTERVAL_MS = 20_000;
/** At least this long between two automatic thoughts. */
export const ANSH_MIN_GAP_MS = 5 * 60_000;
/** "Ask Ansh" may cut in, but no sooner than this after the last thought. */
export const ANSH_ASK_MIN_GAP_MS = 30_000;
/** Thoughts per local day, automatic and asked together. Past it Ansh stays quiet. */
export const ANSH_DAILY_CAP = 40;
/** Recent thoughts kept (on disk and in the brain-state message). */
export const ANSH_RECENT_THOUGHTS = 30;
/** A thought's run is cut short after this long (the fallback thought is used). */
export const ANSH_CLAUDE_TIMEOUT_MS = 60_000;
/** Cap on a thought's stdout. */
export const ANSH_CLAUDE_MAX_BUFFER = 64 * 1024;
/** Longest line Ansh says (characters). */
export const ANSH_SAY_MAX_CHARS = 120;
/** A wait this long (minutes) is "long": it counts as news once it crosses. */
export const ANSH_LONG_WAIT_MINUTES = 10;
/** Task titles and status text are cut to this many characters in the prompt. */
export const ANSH_PROMPT_TEXT_MAX = 80;
/** Environment variable that keeps claude from ever being run for Ansh's
 *  thoughts (set it to one of LOCAL_SESSIONS_OFF_VALUES): the built-in fallback
 *  thoughts are used instead. PIXEL_AGENTS_MANAGER=off does the same. */
export const ANSH_BRAIN_ENV = 'PIXEL_AGENTS_ANSH_BRAIN';
/** ntfy headers for the daily-report push (ASCII only: HTTP header values). */
export const REPORT_NOTIFICATION_TITLE = 'Daily report';
export const REPORT_NOTIFICATION_TAGS = 'clipboard';

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

// ── Office MCP server (mcp/) ─────────────────────────────────
/** Where Claude (or any MCP client) reaches the office: Streamable HTTP,
 *  stateless, JSON responses only. Standalone only. */
export const MCP_PATH = '/mcp';
/** MCP protocol revisions this server speaks, newest first. A client asking
 *  for one of these gets it back; anything else is answered with the first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** read_agent: transcript items returned by default, and at most. */
export const MCP_READ_AGENT_DEFAULT_ITEMS = 20;
export const MCP_READ_AGENT_MAX_ITEMS = 60;
/** read_agent reads at most this much from the end of a transcript. */
export const MCP_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
/** read_agent cuts each message to this many characters. */
export const MCP_ITEM_TEXT_MAX = 1500;
