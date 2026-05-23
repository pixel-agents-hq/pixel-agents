import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { formatToolStatus as formatClaudeToolStatus } from '../claude/claude.js';

const COPILOT_TERMINAL_NAME_PREFIX = 'GitHub Copilot';

function getSessionDirs(workspacePath: string): string[] {
  const dirName = normalizeProjectPath(workspacePath);
  return [path.join(os.homedir(), '.copilot', 'projects', dirName)];
}

function getAllSessionRoots(): string[] {
  return [
    path.join(os.homedir(), '.copilot', 'projects'),
    path.join(os.homedir(), '.copilot', 'session-state'),
  ];
}

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'copilot', args: ['--session-id', sessionId], env: { PWD: cwd } };
}

function getStringField(raw: Record<string, unknown>, snake: string, camel: string): string {
  const value = raw[snake] ?? raw[camel];
  return typeof value === 'string' ? value : '';
}

function getObjectField(
  raw: Record<string, unknown>,
  snake: string,
  camel: string,
): Record<string, unknown> {
  const value = raw[snake] ?? raw[camel];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = getStringField(raw, 'hook_event_name', 'hookEventName');
  const sessionId = getStringField(raw, 'session_id', 'sessionId');
  if (!eventName || !sessionId) return null;
  const normalizedEvent = eventName.toLowerCase();

  switch (normalizedEvent) {
    case 'pretooluse': {
      const toolName = getStringField(raw, 'tool_name', 'toolName');
      const toolInput = getObjectField(raw, 'tool_input', 'toolInput');
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
          runInBackground:
            toolInput.run_in_background === true || toolInput.runInBackground === true,
        },
      };
    }
    case 'posttooluse':
    case 'posttoolusefailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'subagentstart': {
      const toolInput = raw;
      const agentType = getStringField(raw, 'agent_type', 'agentType') || 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hook-sub-${agentType}-${Date.now()}`,
          toolName: agentType,
          input: toolInput,
          runInBackground: raw.run_in_background === true || raw.runInBackground === true,
        },
      };
    }
    case 'subagentstop':
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'current' },
      };
    case 'permissionrequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'notification': {
      const notificationType = getStringField(raw, 'notification_type', 'notificationType');
      if (notificationType === 'permission_prompt' || notificationType === 'permissionPrompt') {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      if (notificationType === 'idle_prompt' || notificationType === 'idlePrompt') {
        return { sessionId, event: { kind: 'turnEnd' } };
      }
      return null;
    }
    case 'sessionstart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: getStringField(raw, 'source', 'source') || undefined,
          transcriptPath: getStringField(raw, 'transcript_path', 'transcriptPath') || undefined,
          cwd: getStringField(raw, 'cwd', 'cwd') || undefined,
        },
      };
    case 'sessionend':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: getStringField(raw, 'reason', 'reason') || undefined,
        },
      };
    default:
      return null;
  }
}

function installHooks(): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(true);
}

export const copilotProvider: HookProvider = {
  kind: 'hook',
  id: 'copilot',
  displayName: 'GitHub Copilot',
  protocolVersion: 1,
  normalizeHookEvent,
  installHooks,
  uninstallHooks,
  areHooksInstalled,
  formatToolStatus: formatClaudeToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),
  subagentToolNames: new Set(['Task', 'Agent']),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: COPILOT_TERMINAL_NAME_PREFIX,
  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,
};
