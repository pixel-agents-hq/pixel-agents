/**
 * OpenCode webhook event normalization.
 *
 * The bridge (or wrapper) POSTs normalized OpenCode events to
 * `/api/hooks/opencode`. This module translates those payloads into
 * the canonical `AgentEvent` format that the Pixel Agents runtime
 * understands.
 *
 * Webhook payload format (sent by the wrapper bridge):
 *
 *   POST /api/hooks/opencode
 *   {
 *     "event_type": "session.status" | "message.updated" | "tool.start" | "tool.end",
 *     "session_id": "ses_...",
 *     "payload": { ... }
 *   }
 */

import type { AgentEvent } from '../../../../../core/src/provider.js';

// ── formatToolStatus ──

export function formatToolStatus(toolName: string, _input?: unknown): string {
  switch (toolName) {
    case 'read':
      return 'Reading file';
    case 'write':
      return 'Writing file';
    case 'edit':
      return 'Editing file';
    case 'glob':
      return 'Searching files';
    case 'grep':
      return 'Searching code';
    case 'websearch':
      return 'Searching the web';
    case 'webfetch':
      return 'Fetching web content';
    case 'github-repo-info':
      return 'Fetching repo info';
    case 'github-list-branches':
      return 'Listing branches';
    case 'github-clone-repo':
      return 'Cloning repository';
    case 'github-create-pr':
      return 'Creating pull request';
    case 'github-comment-pr':
      return 'Commenting on PR';
    case 'plane-create-ticket':
      return 'Creating Plane ticket';
    case 'plane-comment':
      return 'Commenting on ticket';
    case 'plane-update-state':
      return 'Updating ticket state';
    default:
      return `Using ${toolName.replace(/-/g, ' ')}`;
  }
}

// ── normalizeHookEvent ──

export function normalizeOpenCodeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventType = raw.event_type as string | undefined;
  const sessionId = raw.session_id as string | undefined;
  if (!eventType || !sessionId) return null;

  const payload = (raw.payload ?? {}) as Record<string, unknown>;

  switch (eventType) {
    case 'session.status': {
      const status = payload.status;
      if (status === 'busy') {
        return {
          sessionId,
          event: {
            kind: 'sessionStart',
            source: 'opencode',
            cwd: (payload.cwd as string) ?? '/home/agent/workspaces',
          },
        };
      }
      if (status === 'idle') {
        return {
          sessionId,
          event: { kind: 'turnEnd' },
        };
      }
      return null;
    }

    case 'message.updated': {
      const role = payload.role;
      if (role === 'assistant') {
        return {
          sessionId,
          event: {
            kind: 'toolStart',
            toolId: (payload.message_id as string) ?? `msg-${Date.now()}`,
            toolName: (payload.agent as string) ?? 'plan',
          },
        };
      }
      return null;
    }

    case 'tool.start': {
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: (payload.tool_id as string) ?? `tool-${Date.now()}`,
          toolName: (payload.tool_name as string) ?? '',
          input: (payload.input as Record<string, unknown>) ?? undefined,
        },
      };
    }

    case 'tool.end': {
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: (payload.tool_id as string) ?? 'current',
        },
      };
    }

    case 'session.start': {
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: (payload.source as string) ?? 'opencode',
        },
      };
    }

    case 'session.end': {
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: (payload.reason as string) ?? undefined,
        },
      };
    }

    default:
      return null;
  }
}
