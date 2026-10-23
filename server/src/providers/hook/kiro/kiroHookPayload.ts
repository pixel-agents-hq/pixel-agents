import { KIRO_HOOK_EVENTS } from './constants.js';

/** The bridge never forwards prompts, responses, tool output or auth values. */
export function makeKiroHookPayload(
  raw: unknown,
  event: string,
  launchedSessionId?: string,
): Record<string, unknown> | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !KIRO_HOOK_EVENTS.some((name) => name === event)
  ) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const sessionId = launchedSessionId || data.session_id;
  if (typeof sessionId !== 'string' || !sessionId) {
    return null;
  }
  const payload: Record<string, unknown> = {
    hook_event_name: event,
    session_id: sessionId,
  };
  if (typeof data.cwd === 'string') {
    payload.cwd = data.cwd;
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (typeof data.tool_name === 'string') {
      payload.tool_name = data.tool_name;
    }
    if (event === 'PreToolUse' && data.tool_input && typeof data.tool_input === 'object') {
      payload.tool_input = data.tool_input;
    }
  }
  if (event === 'SessionEnd' && typeof data.reason === 'string') {
    payload.reason = data.reason;
  }
  return payload;
}
