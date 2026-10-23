/**
 * Permission approvals from the board: a local session's PermissionRequest
 * hook long-polls the standalone server, which holds the request until someone
 * answers it on the board, the session moves on, or the wait runs out.
 *
 * Kept beside the feature (like the Claude provider's own constants.ts) so the
 * hook script and the server read ONE definition of the route and the limits.
 */

/** Route the hook script long-polls. Bearer-authenticated like the hook route. */
export const PERMISSION_WAIT_PATH = '/api/permissions/wait';

/** How long the server holds one request before answering "expired". Shorter
 *  than both the hook's own HTTP timeout and the hook entry's timeout, so the
 *  normal end of an unanswered request is a clean empty answer, never a kill. */
export const PERMISSION_WAIT_MS = 10 * 60 * 1000;

/** The hook script gives up on the long-poll after this long (server down,
 *  stuck proxy). A little over PERMISSION_WAIT_MS so the server's own expiry
 *  normally wins. */
export const PERMISSION_HOOK_WAIT_MS = PERMISSION_WAIT_MS + 30 * 1000;

/** `timeout` (seconds) on the PermissionRequest hook entry in
 *  ~/.claude/settings.json. Every other event keeps HOOK_TIMEOUT_SECONDS: only
 *  this one waits on a human. Above PERMISSION_HOOK_WAIT_MS so Claude Code
 *  never kills a hook that is about to exit on its own. */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 660;

/** Kill switch: PIXEL_AGENTS_APPROVALS=off (or 0/false/no) stops the hook from
 *  waiting on the board at all. */
export const APPROVALS_ENV = 'PIXEL_AGENTS_APPROVALS';
export const APPROVALS_OFF_VALUES = ['0', 'false', 'off', 'no'] as const;

/** Test-only: shortens the hook's long-poll timeout (never lengthens it). */
export const APPROVALS_WAIT_MS_ENV = 'PIXEL_AGENTS_APPROVALS_WAIT_MS';

/** When the PermissionRequest hook fires before its session is on the board
 *  (adoption still in flight), the server retries resolving the agent for
 *  this long before answering with no decision. */
export const PERMISSION_AGENT_RESOLVE_MS = 3_000;
export const PERMISSION_AGENT_RESOLVE_POLL_MS = 250;

/** Display caps for the approval card. */
export const PERMISSION_DETAIL_MAX_CHARS = 2_000;
/** Lines of an Edit/Write/MultiEdit change shown under the file path. */
export const PERMISSION_DETAIL_CHANGE_LINES = 20;
/** AskUserQuestion on the card: limits on what is accepted and shown. */
export const QUESTION_MAX_QUESTIONS = 8;
export const QUESTION_MAX_OPTIONS = 20;
export const QUESTION_TEXT_MAX_CHARS = 1_000;
/** The free-text "Other" answer. */
export const QUESTION_OTHER_MAX_CHARS = 2_000;
/** Short detail written to approvals.log. */
export const PERMISSION_LOG_DETAIL_MAX_CHARS = 200;

/** Audit trail of board answers, one line each, under ~/.pixel-agents/. */
export const APPROVALS_LOG_FILE_NAME = 'approvals.log';

/** Most bytes of the server's answer the hook script reads. */
export const PERMISSION_RESPONSE_MAX_BYTES = 16 * 1024;
