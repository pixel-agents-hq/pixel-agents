import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { hermesConsentDisclosure } from './consentCopy.js';
import { HERMES_PROVIDER_ID } from './constants.js';
import { areHooksInstalled, installHooks, uninstallHooks } from './hermesHookInstaller.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = stringField(raw, 'hook_event_name');
  if (!eventName) return null;
  const extra = record(raw.extra);
  const sessionId =
    stringField(raw, 'session_id') ??
    stringField(extra, 'session_id') ??
    stringField(extra, 'session_key');
  if (!sessionId) return null;

  switch (eventName) {
    case 'on_session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: stringField(extra, 'platform'),
          cwd: stringField(raw, 'cwd'),
        },
      };
    case 'pre_tool_call': {
      const toolName = stringField(raw, 'tool_name') ?? 'tool';
      const toolId = stringField(extra, 'tool_call_id');
      if (!toolId) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: record(raw.tool_input),
        },
      };
    }
    case 'post_tool_call': {
      const toolId = stringField(extra, 'tool_call_id');
      return toolId ? { sessionId, event: { kind: 'toolEnd', toolId } } : null;
    }
    case 'on_session_end':
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
    case 'on_session_finalize':
    case 'on_session_reset':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: eventName.replace('on_session_', '') },
      };
    case 'subagent_start': {
      const childSessionId = stringField(extra, 'child_session_id');
      if (!childSessionId) return null;
      const role = stringField(extra, 'child_role') ?? 'subagent';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: stringField(extra, 'parent_turn_id') ?? childSessionId,
          toolId: stringField(extra, 'child_subagent_id') ?? childSessionId,
          childSessionId,
          toolName: role,
          input: stringField(extra, 'child_goal'),
          runInBackground: true,
        },
      };
    }
    case 'subagent_stop': {
      const childSessionId = stringField(extra, 'child_session_id');
      if (!childSessionId) return null;
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId: stringField(extra, 'parent_turn_id') ?? childSessionId,
          toolId: stringField(extra, 'child_subagent_id') ?? childSessionId,
          childSessionId,
        },
      };
    }
    case 'pre_approval_request':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'post_approval_response':
      return { sessionId, event: { kind: 'permissionResolved' } };
    default:
      return null;
  }
}

export function formatHermesToolStatus(toolName: string, input?: unknown): string {
  const args = record(input);
  const path = stringField(args, 'path') ?? stringField(args, 'file_path');
  switch (toolName) {
    case 'terminal':
    case 'run_command':
    case 'shell': {
      const command = stringField(args, 'command') ?? stringField(args, 'cmd') ?? '';
      const shown =
        command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
          ? `${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}…`
          : command;
      return shown ? `Running: ${shown}` : 'Running command';
    }
    case 'read_file':
    case 'view_file':
      return `Reading ${path ?? 'file'}`;
    case 'write_file':
    case 'edit_file':
    case 'patch':
      return `Editing ${path ?? 'files'}`;
    case 'search_files':
      return 'Searching files';
    case 'web_search':
      return 'Searching the web';
    case 'web_extract':
    case 'web_fetch':
      return 'Reading web content';
    case 'delegate_task':
      return 'Delegating task';
    default:
      return toolName.startsWith('mcp__')
        ? `Using ${toolName.split('__').at(-1) ?? toolName}`
        : `Using ${toolName}`;
  }
}

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: HERMES_PROVIDER_ID,
  displayName: 'Hermes Agent',
  protocolVersion: 1,
  adoptOnSessionStart: true,
  normalizeHookEvent,
  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure: hermesConsentDisclosure,
  formatToolStatus: formatHermesToolStatus,
  permissionExemptTools: new Set(['delegate_task']),
  subagentToolNames: new Set(['delegate_task']),
  readingTools: new Set(['read_file', 'view_file', 'search_files', 'web_search', 'web_extract']),
  terminalNamePrefix: 'Hermes',
};
