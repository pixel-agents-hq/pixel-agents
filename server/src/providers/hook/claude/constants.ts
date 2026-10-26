/**
 * Claude-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Claude
 * unless Claude is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

/** Output filename after esbuild compiles claude-hook.ts to CJS (source is .ts, output is .js) */
export const CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';

/** The script name we shipped before the rename to claude-hook.js. Still
 *  recognized as ours so a very old install can be migrated or removed. */
export const LEGACY_HOOK_SCRIPT_NAME = 'pixel-agents-hook.js';

/** Hook events to install in ~/.claude/settings.json. This list is the whole
 *  data-collection surface: Claude Code POSTs each of these payloads to the
 *  local server, so an event we do not act on is scope we should not ask for.
 *  SessionStart/SessionEnd handle session lifecycle (start, /clear, resume, exit).
 *  Stop/PermissionRequest/Notification handle turn completion and permission UI.
 *  SubagentStart/SubagentStop/TeammateIdle/TaskCompleted power Agent Teams.
 *
 *  Deliberately NOT installed: UserPromptSubmit and TaskCreated. Both normalize
 *  to null (nothing in the runtime consumes them), so installing them only
 *  forwarded the user's prompt text and task payloads to the server to be
 *  dropped. A legacy install that still carries them is migrated on the next
 *  install (see installEntries' unlisted-event sweep). */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
] as const;

/** Suffix of the one-time pre-modification backup of settings.json. Brand-named
 *  rather than a generic `.backup`, which collides with other tools' backup
 *  convention: a foreign `.backup` sitting next to settings.json must not make
 *  us believe we already saved the user's original. */
export const SETTINGS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a settings.json we create ourselves. An existing file's mode is
 *  preserved instead; this is only the fresh-file default, and it is the
 *  restrictive one because the file holds the user's permission rules. */
export const SETTINGS_FRESH_FILE_MODE = 0o600;

/** Attempts for the settings.json read-modify-write cycle. Claude Code writes
 *  the same file and does not coordinate with us, so the cycle re-reads the
 *  file immediately before committing and retries when it changed. The verify
 *  sits after mkdir/backup/tmp-write, so the residual lost-update window is one
 *  read plus one rename — narrowed, NOT eliminated: a Claude Code write landing
 *  inside that gap is still overwritten by our rename. A lockfile would not
 *  help (Claude Code would not honor it, and stale locks add failure modes
 *  worse than the race). */
export const SETTINGS_MUTATE_ATTEMPTS = 3;
/** Delay between settings.json mutation attempts (lets a concurrent writer finish). */
export const SETTINGS_MUTATE_RETRY_DELAY_MS = 100;

/** Terminal name prefix used when launching Claude Code in VS Code.
 *  Used by the extension to match terminals to agents for adoption. */
export const CLAUDE_TERMINAL_NAME_PREFIX = 'Claude Code';

// ── Context windows (per model, in tokens) ──────────────────
//
// Transcripts report token usage but never the window it counts against, so
// these are the denominators behind every context gauge. Measured against
// real transcripts, where the largest context seen per model was: opus-4-8
// 957k, fable-5 788k, opus-5 459k, sonnet-5 233k -- every current model runs
// the large window. Haiku is the small-window exception.
/** Current Claude models (Opus/Sonnet/Fable 5, Opus 4.8). */
export const CLAUDE_LARGE_CONTEXT_WINDOW = 1_000_000;
/** Haiku, and older models that never got the large window. */
export const CLAUDE_SMALL_CONTEXT_WINDOW = 200_000;
/** Model ids that run the small window. Everything else gets the large one:
 *  guessing small for a large model pins every gauge in the red, while the
 *  reverse is a quiet under-read that the runtime's widening still corrects. */
export const CLAUDE_SMALL_CONTEXT_MODEL_PATTERN = /haiku|claude-[123]|-4-[01]\b/i;

// ── Session bar (Claude Code statusLine) ────────────────────
//
// The statusLine command prints one line under the prompt and leaves small
// JSON snapshots that Nakama reads: no hook, no network, zero tokens.
/** Output filename after esbuild compiles nakama-statusline.ts. */
export const STATUSLINE_SCRIPT_NAME = 'nakama-statusline.js';
/** Folder (under SERVER_JSON_DIR) for the script and its snapshots. */
export const STATUSLINE_DIR = 'statusline';
/** One snapshot per session: `<sessionId>.json`. */
export const STATUSLINE_SESSIONS_DIR = 'sessions';
/** Latest account-wide plan limits (5-hour and 7-day). */
export const STATUSLINE_USAGE_FILE = 'usage.json';
/** Key names and types of the last payload, to notice schema changes. */
export const STATUSLINE_SHAPE_FILE = 'last-input-shape.json';
/** Claude Code closes stdin right away; this only guards a stuck pipe. */
export const STATUSLINE_STDIN_TIMEOUT_MS = 1_000;
/** Session snapshots older than this are deleted when a prune runs. */
export const STATUSLINE_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Fraction of runs that prune, so the folder stays small at ~no cost. */
export const STATUSLINE_PRUNE_CHANCE = 0.02;
/** Orphaned `*.tmp` files (a run killed mid-write) older than this are swept. */
export const STATUSLINE_TMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Rename retries when Windows holds the target open (antivirus, a reader). */
export const STATUSLINE_RENAME_ATTEMPTS = 3;
export const STATUSLINE_RENAME_RETRY_MS = 10;
/** Two `resets_at` this close (seconds) name the same plan window. */
export const STATUSLINE_SAME_WINDOW_SLACK_S = 300;
/** Bar look: cells, glyphs, and the usage that turns it yellow / red. */
export const STATUSLINE_BAR_CELLS = 5;
export const STATUSLINE_BAR_FULL = '▰';
export const STATUSLINE_BAR_EMPTY = '▱';
export const STATUSLINE_WARN_PCT = 50;
export const STATUSLINE_DANGER_PCT = 80;
export const STATUSLINE_SEPARATOR = ' · ';
export const STATUSLINE_UNKNOWN = '—';
export const STATUSLINE_FALLBACK_NAME = 'Nakama';
export const STATUSLINE_LOCALE = 'es-CL';
export const STATUSLINE_ANSI = {
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
} as const;
/** describeShape bounds: nesting depth and keys recorded per object. */
export const STATUSLINE_SHAPE_MAX_DEPTH = 4;
export const STATUSLINE_SHAPE_MAX_KEYS = 50;
