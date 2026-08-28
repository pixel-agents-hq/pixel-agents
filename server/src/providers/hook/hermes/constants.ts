export const HERMES_PROVIDER_ID = 'hermes';
export const HERMES_MANAGED_BY = 'pixel-agents';
export const HERMES_TARGET_NAME_PREFIX = 'pixel-agents:';
export const HERMES_HOOK_EVENTS = [
  'on_session_start',
  'pre_tool_call',
  'post_tool_call',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'subagent_start',
  'subagent_stop',
  'pre_approval_request',
  'post_approval_response',
] as const;
