/**
 * Codex-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider build doesn't accidentally depend on Codex unless
 * Codex is the active provider.
 */

/** Codex CLI has no hooks/plugin API (confirmed against codex-cli 0.144.1: `codex
 *  --help` lists no `hooks` subcommand, and there is no config.toml hook surface).
 *  What it does expose is a structured, append-only JSONL rollout per session at
 *  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. This provider's "hook install"
 *  is therefore a tailer that reads that structured JSONL and re-emits it through
 *  the exact same POST /api/hooks/:providerId ingress a real hook script uses --
 *  structured events, never terminal-output scraping. */
export const CODEX_SESSIONS_DIRNAME = 'sessions';

/** How often the tailer re-scans ~/.codex/sessions for new/changed files. */
export const CODEX_POLL_INTERVAL_MS = 1500;

/** A rollout file with no new bytes for this long is assumed abandoned (the
 *  Codex process exited without an explicit end-of-session record -- JSONL
 *  rollouts don't write one). This is a heuristic, not a real signal: it trades
 *  a few extra minutes of a "Done" character for never leaving a stale one
 *  forever. Documented in codex.ts. */
export const CODEX_SESSION_STALE_MS = 10 * 60 * 1000;

/** Codex `response_item` function_call names that read/search rather than write
 *  or execute. Codex's primary tool is a general-purpose shell (`exec_command`),
 *  so most reads and writes are indistinguishable at the tool-name level; this
 *  list only covers the small set of dedicated read-style tools Codex exposes
 *  outside the shell. */
export const CODEX_READING_TOOL_NAMES = new Set(['read_file', 'view_image', 'web_search']);

export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
