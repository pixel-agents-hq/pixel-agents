import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { HERMES_TERMINAL_NAME_PREFIX } from './constants.js';
import {
  areHooksInstalled,
  copyHookScript,
  installHooks,
  uninstallHooks,
} from './hermesHookInstaller.js';

function base(p: unknown): string {
  return typeof p === 'string' ? path.basename(p) : '';
}

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'terminal': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd}`;
    }
    case 'read_file':
      return `Reading ${base(inp.path)}`;
    case 'write_file':
      return `Writing ${base(inp.path)}`;
    case 'patch':
      return `Editing ${base(inp.path)}`;
    case 'search_files':
      return 'Searching files';
    case 'browser':
      return 'Fetching web content';
    case 'process':
      return 'Running process';
    default:
      return `Using ${toolName}`;
  }
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = raw.session_id as string;
  if (!sessionId) return null;

  switch (raw.hook_event_name) {
    case 'on_session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.model === 'string' ? raw.model : undefined,
        },
      };

    case 'pre_tool_call': {
      const toolId = raw.tool_call_id as string | undefined;
      if (!toolId) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName: (raw.tool_name as string) ?? 'unknown',
          input: raw.args,
        },
      };
    }

    case 'post_tool_call': {
      const toolId = raw.tool_call_id as string | undefined;
      if (!toolId) return null;
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId },
      };
    }

    case 'post_llm_call':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'on_session_end':
      return { sessionId, event: { kind: 'sessionEnd' } };

    default:
      return null;
  }
}

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes',
  protocolVersion: 1,

  normalizeHookEvent,
  formatToolStatus,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  permissionExemptTools: new Set(['read_file', 'search_files', 'process']),
  subagentToolNames: new Set(),
  readingTools: new Set(['read_file', 'search_files', 'browser']),
  terminalNamePrefix: HERMES_TERMINAL_NAME_PREFIX,
};
