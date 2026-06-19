export const HERMES_HOOK_SCRIPT_NAME = 'hermes-hook.js';

export const HERMES_HOOK_EVENTS = [
  'pre_tool_call',
  'post_tool_call',
  'post_llm_call',
  'on_session_start',
  'on_session_end',
] as const;

export const HERMES_TERMINAL_NAME_PREFIX = 'hermes';
