import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import {
  areOpenClawHooksInstalled,
  installOpenClawHooks,
  uninstallOpenClawHooks,
} from './openclawPluginInstaller.js';

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  return typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;
}

export function normalizeOpenClawHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = stringField(raw, 'event');
  const sessionId = stringField(raw, 'session_id');
  if (!eventName || !sessionId) return null;

  switch (eventName) {
    case 'session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: stringField(raw, 'source'),
          cwd: stringField(raw, 'cwd'),
        },
      };
    case 'tool_start': {
      const toolName = stringField(raw, 'tool_name');
      const toolId = stringField(raw, 'tool_id');
      if (!toolName || !toolId) return null;
      return { sessionId, event: { kind: 'toolStart', toolId, toolName } };
    }
    case 'tool_end': {
      const toolId = stringField(raw, 'tool_id');
      return toolId ? { sessionId, event: { kind: 'toolEnd', toolId } } : null;
    }
    case 'turn_end':
      return {
        sessionId,
        event: { kind: 'turnEnd', awaitingInput: raw.awaiting_input === true },
      };
    case 'session_end':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: stringField(raw, 'reason') },
      };
    case 'subagent_start': {
      const parentToolId = stringField(raw, 'parent_tool_id');
      const toolId = stringField(raw, 'tool_id');
      const toolName = stringField(raw, 'tool_name');
      if (!parentToolId || !toolId || !toolName) return null;
      return {
        sessionId,
        event: { kind: 'subagentStart', parentToolId, toolId, toolName },
      };
    }
    case 'subagent_end': {
      const parentToolId = stringField(raw, 'parent_tool_id');
      const toolId = stringField(raw, 'tool_id');
      if (!parentToolId || !toolId) return null;
      return { sessionId, event: { kind: 'subagentEnd', parentToolId, toolId } };
    }
    default:
      return null;
  }
}

export function formatOpenClawToolStatus(toolName: string): string {
  switch (toolName) {
    case 'exec':
    case 'exec_command':
      return 'Running a command';
    case 'apply_patch':
      return 'Editing files';
    case 'web_fetch':
    case 'web__run':
      return 'Researching the web';
    case 'browser':
      return 'Using the browser';
    case 'memory_search':
    case 'memory_get':
      return 'Checking memory';
    case 'sessions_spawn':
    case 'spawn_agent':
      return 'Starting a sub-agent';
    default:
      return `Using ${toolName}`;
  }
}

export const openClawProvider: HookProvider = {
  kind: 'hook',
  id: 'openclaw',
  displayName: 'OpenClaw',
  protocolVersion: 1,
  normalizeHookEvent: normalizeOpenClawHookEvent,
  installHooks: async () => installOpenClawHooks(),
  uninstallHooks: uninstallOpenClawHooks,
  areHooksInstalled: areOpenClawHooksInstalled,
  consentDisclosure: () => ({
    headline: CONSENT_INSTALL_HEADLINE,
    disclosure: CONSENT_DISCLOSURE,
  }),
  formatToolStatus: formatOpenClawToolStatus,
  permissionExemptTools: new Set(['memory_search', 'memory_get', 'sessions_spawn', 'spawn_agent']),
  subagentToolNames: new Set(['sessions_spawn', 'spawn_agent']),
  readingTools: new Set(['web_fetch', 'web__run', 'browser', 'memory_search', 'memory_get']),
};
