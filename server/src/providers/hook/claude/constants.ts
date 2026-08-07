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
