/**
 * Cursor-specific constants. Kept next to the provider so a future
 * single-provider `server/` build doesn't depend on Cursor unless Cursor is
 * registered.
 */

/** Output filename after esbuild compiles cursor-hook.ts to CJS. */
export const CURSOR_HOOK_SCRIPT_NAME = 'cursor-hook.js';

/**
 * Hook events to install in ~/.cursor/hooks.json. This list is the whole
 * data-collection surface: Cursor POSTs each of these payloads to the local
 * server, so an event we do not act on is scope we should not ask for.
 *
 * Official Cursor agent-hook names (camelCase). No PermissionRequest /
 * Notification analogue — do not invent those.
 */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'stop',
] as const;

/** Suffix of the one-time pre-modification backup of hooks.json. */
export const SETTINGS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a hooks.json we create ourselves. */
export const SETTINGS_FRESH_FILE_MODE = 0o600;

/** Attempts for the hooks.json read-modify-write cycle. */
export const SETTINGS_MUTATE_ATTEMPTS = 3;
/** Delay between hooks.json mutation attempts. */
export const SETTINGS_MUTATE_RETRY_DELAY_MS = 100;
