// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = ".pixel-agents";
export const LAYOUT_FILE_NAME = "layout.json";
export const CONFIG_FILE_NAME = "config.json";
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = "layoutRevision";

// ── Settings Persistence (VS Code globalState keys) ─────────
export const GLOBAL_KEY_SOUND_ENABLED = "pixel-agents.soundEnabled";
export const GLOBAL_KEY_LAST_SEEN_VERSION = "pixel-agents.lastSeenVersion";
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = "pixel-agents.alwaysShowLabels";
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = "pixel-agents.watchAllSessions";
export const GLOBAL_KEY_HOOKS_ENABLED = "pixel-agents.hooksEnabled";
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = "pixel-agents.hooksInfoShown";

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = "pixel-agents.panelView";
export const COMMAND_SHOW_PANEL = "pixel-agents.showPanel";
export const COMMAND_EXPORT_DEFAULT_LAYOUT = "pixel-agents.exportDefaultLayout";
export const WORKSPACE_KEY_AGENTS = "pixel-agents.agents";
export const WORKSPACE_KEY_AGENT_SEATS = "pixel-agents.agentSeats";
export const WORKSPACE_KEY_LAYOUT = "pixel-agents.layout";
export const TERMINAL_NAME_PREFIX = "Claude Code";
