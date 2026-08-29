import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './cursorHookInstaller.js';

// ── formatToolStatus ──

function basenameOf(input: Record<string, unknown>): string {
  const raw = input.path ?? input.file_path ?? input.filePath ?? input.target_file;
  return typeof raw === 'string' ? path.basename(raw) : '';
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const name = toolName.startsWith('MCP:') ? toolName.slice(4) : toolName;
  switch (toolName) {
    case 'Read':
      return `Reading ${basenameOf(inp)}`;
    case 'Write':
      return `Writing ${basenameOf(inp)}`;
    case 'Delete':
      return `Deleting ${basenameOf(inp)}`;
    case 'Shell': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Grep':
      return 'Searching code';
    case 'Task': {
      const desc =
        (typeof inp.description === 'string' && inp.description) ||
        (typeof inp.task === 'string' && inp.task) ||
        (typeof inp.prompt === 'string' && inp.prompt) ||
        '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    default:
      return `Using ${name}`;
  }
}

function firstWorkspaceRoot(raw: Record<string, unknown>): string | undefined {
  const roots = raw.workspace_roots;
  if (!Array.isArray(roots)) return undefined;
  const first = roots.find((r) => typeof r === 'string' && r.length > 0);
  return typeof first === 'string' ? first : undefined;
}

function realTranscriptPath(raw: Record<string, unknown>): string | undefined {
  const p = raw.transcript_path;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

function sessionIdFrom(raw: Record<string, unknown>): string | null {
  if (typeof raw.session_id === 'string' && raw.session_id.length > 0) return raw.session_id;
  if (typeof raw.conversation_id === 'string' && raw.conversation_id.length > 0) {
    return raw.conversation_id;
  }
  return null;
}

/**
 * Cursor official hook names are camelCase. The hook script maps
 * `conversation_id` → `session_id` before POST, but normalize also accepts
 * `conversation_id` so a raw payload still works.
 */
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = sessionIdFrom(raw);
  if (typeof eventName !== 'string' || sessionId === null) return null;

  switch (eventName) {
    case 'preToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      const toolId =
        typeof raw.tool_use_id === 'string' && raw.tool_use_id.length > 0
          ? raw.tool_use_id
          : `hook-${Date.now()}`;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: toolInput,
        },
      };
    }

    case 'postToolUse':
    case 'postToolUseFailure': {
      const toolId =
        typeof raw.tool_use_id === 'string' && raw.tool_use_id.length > 0
          ? raw.tool_use_id
          : 'current';
      return { sessionId, event: { kind: 'toolEnd', toolId } };
    }

    case 'stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'subagentStart': {
      const toolName = typeof raw.subagent_type === 'string' ? raw.subagent_type : 'unknown';
      const toolId =
        typeof raw.subagent_id === 'string' && raw.subagent_id.length > 0
          ? raw.subagent_id
          : `hook-sub-${toolName}-${Date.now()}`;
      const parentToolId =
        typeof raw.tool_call_id === 'string' && raw.tool_call_id.length > 0
          ? raw.tool_call_id
          : 'current';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId,
          toolId,
          toolName,
          input: raw,
          runInBackground: raw.is_parallel_worker === true,
        },
      };
    }

    case 'subagentStop': {
      const toolId =
        typeof raw.subagent_id === 'string' && raw.subagent_id.length > 0
          ? raw.subagent_id
          : 'current';
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId },
      };
    }

    case 'sessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.composer_mode === 'string' ? raw.composer_mode : undefined,
          transcriptPath: realTranscriptPath(raw),
          cwd: firstWorkspaceRoot(raw) ?? (typeof raw.cwd === 'string' ? raw.cwd : undefined),
        },
      };

    case 'sessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    default:
      return null;
  }
}

async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  await installerInstallHooks();
}

async function uninstallHooks(): Promise<void> {
  await installerUninstallHooks();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return { headline: CONSENT_INSTALL_HEADLINE, disclosure: CONSENT_DISCLOSURE };
}

export const cursorProvider: HookProvider = {
  kind: 'hook',
  id: 'cursor',
  displayName: 'Cursor',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['Task']),
  subagentToolNames: new Set(['Task']),
  readingTools: new Set(['Read', 'Grep']),
};
