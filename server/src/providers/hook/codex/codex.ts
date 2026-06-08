import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './codexHookInstaller.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '\u2026' : value;
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = asRecord(input);
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'exec_command':
    case 'Bash': {
      const cmd = stringField(inp, 'cmd') ?? stringField(inp, 'command') ?? '';
      return `Running: ${truncate(cmd, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
    }
    case 'apply_patch':
      return 'Editing files';
    case 'read_mcp_resource':
      return 'Reading resource';
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return 'Listing resources';
    case 'tool_search':
    case 'tool_search_tool':
      return 'Searching tools';
    case 'web.run':
    case 'web_search':
      return 'Searching the web';
    case 'view_image':
      return `Viewing ${base(inp.path)}`;
    case 'open':
      return 'Opening page';
    case 'spawn_agent': {
      const name = stringField(inp, 'name') ?? stringField(inp, 'agent_type');
      return name ? `Subtask: ${name}` : 'Running subtask';
    }
    default:
      return `Using ${toolName}`;
  }
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexSessionDirForOffset(offsetDays: number): string {
  const date = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(getCodexHome(), 'sessions', year, month, day);
}

function getSessionDirs(_workspacePath: string): string[] {
  return [codexSessionDirForOffset(0), codexSessionDirForOffset(1)];
}

function getAllSessionRoots(): string[] {
  return [path.join(getCodexHome(), 'sessions')];
}

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args: string[] = [];
  if (opts?.bypassPermissions) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  return { command: 'codex', args, env: { PWD: cwd } };
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = stringField(raw, 'hook_event_name');
  const sessionId = stringField(raw, 'session_id');
  if (!eventName || !sessionId) return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolInput = asRecord(raw.tool_input ?? raw.input);
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: stringField(raw, 'tool_use_id') ?? `hook-${Date.now()}`,
          toolName: stringField(raw, 'tool_name') ?? '',
          input: toolInput,
          runInBackground:
            toolInput.run_in_background === true || toolInput.runInBackground === true,
        },
      };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: stringField(raw, 'tool_use_id') ?? 'current' },
      };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'SubagentStart': {
      const toolInput = asRecord(raw);
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId:
            stringField(raw, 'parent_tool_use_id') ??
            stringField(raw, 'parentToolUseId') ??
            'current',
          toolId: stringField(raw, 'tool_use_id') ?? `hook-sub-${Date.now()}`,
          toolName:
            stringField(raw, 'agent_type') ??
            stringField(raw, 'subagent_type') ??
            stringField(raw, 'tool_name') ??
            'subagent',
          input: toolInput,
          runInBackground: raw.run_in_background === true || raw.runInBackground === true,
        },
      };
    }
    case 'SubagentStop':
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId:
            stringField(raw, 'parent_tool_use_id') ??
            stringField(raw, 'parentToolUseId') ??
            'current',
          toolId: stringField(raw, 'tool_use_id') ?? 'current',
        },
      };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: stringField(raw, 'source'),
          transcriptPath: stringField(raw, 'transcript_path'),
          cwd: stringField(raw, 'cwd'),
        },
      };
    case 'SessionEnd':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: stringField(raw, 'reason') },
      };
    case 'UserPromptSubmit':
    case 'PreCompact':
    case 'PostCompact':
    default:
      return null;
  }
}

function parseTranscriptLine(line: string): AgentEvent | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const recordType = stringField(record, 'type');
  if (recordType === 'session_meta') {
    const payload = asRecord(record.payload);
    return {
      kind: 'sessionStart',
      source: stringField(payload, 'source'),
      cwd: stringField(payload, 'cwd'),
    };
  }

  if (recordType === 'event_msg') {
    const payload = asRecord(record.payload);
    if (stringField(payload, 'type') === 'task_complete') {
      return { kind: 'turnEnd' };
    }
    return null;
  }

  if (recordType !== 'response_item') return null;

  const payload = asRecord(record.payload);
  const payloadType = stringField(payload, 'type');
  switch (payloadType) {
    case 'function_call':
      return {
        kind: 'toolStart',
        toolId: stringField(payload, 'call_id') ?? `call-${Date.now()}`,
        toolName: stringField(payload, 'name') ?? 'function_call',
        input: safeJsonParse(payload.arguments),
      };
    case 'function_call_output':
      return { kind: 'toolEnd', toolId: stringField(payload, 'call_id') ?? 'current' };
    case 'tool_search_call':
      return {
        kind: 'toolStart',
        toolId: stringField(payload, 'call_id') ?? `tool-search-${Date.now()}`,
        toolName: 'tool_search',
        input: safeJsonParse(payload.args ?? payload.arguments),
      };
    case 'tool_search_output':
      return { kind: 'toolEnd', toolId: stringField(payload, 'call_id') ?? 'current' };
    case 'custom_tool_call':
      return {
        kind: 'toolStart',
        toolId: stringField(payload, 'call_id') ?? `custom-${Date.now()}`,
        toolName: stringField(payload, 'name') ?? 'custom_tool',
        input: safeJsonParse(payload.input ?? payload.arguments),
      };
    case 'custom_tool_call_output':
      return { kind: 'toolEnd', toolId: stringField(payload, 'call_id') ?? 'current' };
    case 'patch_apply_end':
    case 'mcp_tool_call_end': {
      const callId = stringField(payload, 'call_id');
      return callId ? { kind: 'toolEnd', toolId: callId } : null;
    }
    default:
      return null;
  }
}

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  installerInstallHooks();
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  installerUninstallHooks();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set([
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'read_mcp_resource',
    'tool_search',
    'tool_search_tool',
    'view_image',
  ]),
  subagentToolNames: new Set(['spawn_agent']),
  readingTools: new Set([
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'read_mcp_resource',
    'tool_search',
    'tool_search_tool',
    'view_image',
    'web.run',
    'web_search',
  ]),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  parseTranscriptLine,
  buildLaunchCommand,
};
