/**
 * Codex-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Codex
 * unless Codex is an active provider.
 */

/** Output filename after esbuild compiles codex-hook.ts to CJS. */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Hook events to install in ~/.codex/hooks.json.
 *  Codex's hooks system is experimental (feature-flagged) and only supports
 *  these 5 events today: SessionStart (session lifecycle), PreToolUse/PostToolUse
 *  (Bash only), UserPromptSubmit, Stop (turn completion). No subagent, file-write,
 *  or notification events exist yet -- see docs/research at pixel-agents-hq for
 *  the upstream gap list. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
] as const;

/** Terminal name prefix used when launching Codex in VS Code (heuristic adoption). */
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
