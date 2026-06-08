/**
 * Codex-specific constants. Kept separate from server-wide constants so the
 * provider can be wired or removed independently from Claude.
 */

/** Output filename after esbuild compiles codex-hook.ts to CJS. */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Hook events to install in ~/.codex/hooks.json.
 *  These are the documented Codex hook events that Pixel Agents can normalize.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Terminal name prefix used when launching Codex in VS Code. */
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
