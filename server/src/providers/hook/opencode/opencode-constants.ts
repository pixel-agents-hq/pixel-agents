/**
 * OpenCode provider constants.
 *
 * Tool classification sets for the OpenCode agent runtime.
 */

export const OPENCODE_TERMINAL_NAME_PREFIX = 'opencode';

/** Tools that emit "reading" animation (file examination, search, fetch). */
export const OPENCODE_READING_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'websearch',
  'webfetch',
  'github-repo-info',
  'github-list-branches',
]);

/** Tools that spawn sub-agent characters. */
export const OPENCODE_SUBAGENT_TOOLS = new Set<string>([
  'Task',
  'Agent',
]);

/** Tools that don't trigger permission timers. */
export const OPENCODE_PERMISSION_EXEMPT_TOOLS = new Set<string>([
  'read',
  'glob',
  'grep',
]);

/** Event types that the bridge sends to the webhook endpoint. */
export const OPENCODE_EVENT_TYPES = {
  SESSION_STATUS: 'session.status',
  MESSAGE_UPDATED: 'message.updated',
  TOOL_START: 'tool.start',
  TOOL_END: 'tool.end',
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
} as const;
