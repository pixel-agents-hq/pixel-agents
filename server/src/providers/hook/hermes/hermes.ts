import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { HERMES_TERMINAL_NAME_PREFIX } from './constants.js';
import {
  areHermesHooksInstalled,
  installHermesHooks,
  uninstallHermesHooks,
} from './hermesHookInstaller.js';

// ── formatToolStatus ──
//
// Hermes's tool surface is large and highly configurable (MCP servers, gateway
// tools, cron, kanban, ...), so this only special-cases the common built-ins;
// everything else falls back to the raw tool name, same pattern as Claude/Codex.

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'terminal':
    case 'run_command':
    case 'shell': {
      const cmd = (inp.command as string) || (inp.cmd as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '…' : cmd}`;
    }
    case 'read_file':
    case 'view_file':
      return `Reading ${typeof inp.path === 'string' ? inp.path : 'file'}`;
    case 'write_file':
    case 'edit_file':
      return `Editing ${typeof inp.path === 'string' ? inp.path : 'file'}`;
    case 'web_search':
      return 'Searching the web';
    case 'web_fetch':
      return 'Fetching web content';
    default:
      return toolName.startsWith('mcp__')
        ? `Using ${toolName.split('__').pop()}`
        : `Using ${toolName}`;
  }
}

// ── normalizeHookEvent ──
//
// Raw fields come from pixel_agents_bridge_plugin.py's _emit() calls -- HERE and
// HERE ONLY, mirroring claude.ts's and codex.ts's normalization boundary. That
// plugin defines its own event vocabulary (SessionStart/ExecStart/ExecEnd/
// TurnEnd/SessionEnd/SubagentStart/SubagentStop) mapped from Hermes's *documented*
// plugin-hook catalog (see constants.ts) -- not invented, not scraped.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: { kind: 'sessionStart', cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    case 'ExecStart': {
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : `hermes-${Date.now()}`;
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'tool';
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: raw.tool_input },
      };
    }

    case 'ExecEnd': {
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : 'current';
      return { sessionId, event: { kind: 'toolEnd', toolId } };
    }

    // Hermes's on_session_end fires per-turn (see plugin docstring), so this is
    // the turnEnd signal, not process exit -- SessionEnd (above) covers real
    // teardown via on_session_finalize.
    case 'TurnEnd':
      return {
        sessionId,
        event: { kind: 'turnEnd', awaitingInput: raw.awaiting_input === true },
      };

    case 'SubagentStart': {
      const childSessionId =
        typeof raw.child_session_id === 'string' ? raw.child_session_id : `sub-${Date.now()}`;
      const agentType = typeof raw.agent_type === 'string' ? raw.agent_type : 'subagent';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: childSessionId,
          toolName: agentType,
          input: raw.goal,
        },
      };
    }

    case 'SubagentStop': {
      const childSessionId =
        typeof raw.child_session_id === 'string' ? raw.child_session_id : 'current';
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: childSessionId },
      };
    }

    default:
      return null;
  }
}

// ── Installer wrappers ──

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  return installHermesHooks();
}

function uninstallHooks(): Promise<void> {
  return uninstallHermesHooks();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(areHermesHooksInstalled());
}

// ── The provider ──

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes Agent',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set(['read_file', 'view_file', 'web_search', 'web_fetch']),
  terminalNamePrefix: HERMES_TERMINAL_NAME_PREFIX,
};
