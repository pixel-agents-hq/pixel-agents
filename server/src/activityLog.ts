import type { ActivityEntry } from '../../core/src/messages.js';
import type { AgentEvent, HookProvider } from '../../core/src/provider.js';

/**
 * Map a normalized AgentEvent to a feed entry, or null for kinds we don't surface
 * (toolEnd, subagentEnd, subagentTurnEnd, progress). Pure — `now` is injected so it
 * is trivially testable.
 */
export function buildActivityEntry(
  event: AgentEvent,
  provider: HookProvider,
  now: number,
): ActivityEntry | null {
  switch (event.kind) {
    case 'toolStart':
      return {
        ts: now,
        kind: 'tool',
        label: provider.formatToolStatus(event.toolName, event.input),
        toolName: event.toolName,
      };
    case 'subagentStart':
      return {
        ts: now,
        kind: 'subagent',
        label: `Subtask: ${event.toolName}`,
        toolName: event.toolName,
      };
    case 'turnEnd':
      return {
        ts: now,
        kind: 'turnEnd',
        label: event.awaitingInput ? 'Waiting for input' : 'Turn ended',
      };
    case 'permissionRequest':
      return { ts: now, kind: 'permission', label: 'Needs approval' };
    case 'sessionStart':
      return { ts: now, kind: 'session', label: 'Session started' };
    case 'sessionEnd':
      return {
        ts: now,
        kind: 'session',
        label: event.reason ? `Session ended (${event.reason})` : 'Session ended',
      };
    default:
      return null;
  }
}
