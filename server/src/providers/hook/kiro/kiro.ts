import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import {
  KIRO_AGENT_NAME,
  KIRO_DISPLAY_NAME,
  KIRO_EXECUTABLE_ENV,
  KIRO_PROVIDER_ID,
  KIRO_READING_TOOLS,
  KIRO_SESSION_ENV,
  KIRO_TURN_TOOL_ID,
} from './constants.js';
import {
  areKiroHooksInstalled,
  areKiroHooksReady,
  installKiroHooks,
  uninstallKiroHooks,
} from './kiroHookInstaller.js';

export function resolveKiroExecutable(): string {
  const configured = process.env[KIRO_EXECUTABLE_ENV];
  if (configured) {
    return configured;
  }
  const name = process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli';
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, name)),
    path.join(os.homedir(), '.local', 'bin', name),
  ];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'Kiro-Cli',
        name,
      ),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? name;
}

export function normalizeKiroHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = raw.session_id;
  if (typeof sessionId !== 'string' || !sessionId || typeof raw.hook_event_name !== 'string') {
    return null;
  }
  switch (raw.hook_event_name) {
    case 'SessionStart':
    case 'agentSpawn':
      return {
        sessionId,
        event: { kind: 'sessionStart', cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined },
      };
    case 'UserPromptSubmit':
    case 'userPromptSubmit':
      // The hook proves a turn started. Prompt text is deliberately not relayed.
      return {
        sessionId,
        event: { kind: 'toolStart', toolId: KIRO_TURN_TOOL_ID, toolName: 'thinking' },
      };
    case 'PreToolUse':
    case 'preToolUse': {
      if (typeof raw.tool_name !== 'string' || !raw.tool_name) {
        return null;
      }
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: 'current',
          toolName: raw.tool_name,
          input: raw.tool_input,
        },
      };
    }
    case 'PostToolUse':
    case 'postToolUse':
      // Kiro's documented hook payload has no tool-call id. The runtime's
      // current-tool sentinel correlates these sequential tool events.
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'Stop':
    case 'stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'SessionEnd':
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

export function formatKiroToolStatus(toolName: string, input?: unknown): string {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const filePath =
    typeof data.path === 'string'
      ? data.path
      : typeof data.file_path === 'string'
        ? data.file_path
        : '';
  switch (toolName) {
    case 'thinking':
      return 'Thinking';
    case 'read':
    case 'read_file':
    case 'list_directory':
    case 'fs_read':
      return filePath ? `Reading ${path.basename(filePath)}` : 'Reading files';
    case 'write':
    case 'write_file':
    case 'str_replace':
    case 'fs_write':
      return filePath ? `Editing ${path.basename(filePath)}` : 'Editing files';
    case 'grep_search':
    case 'file_search':
    case 'grep':
    case 'glob':
    case 'code':
      return 'Searching code';
    case 'shell':
    case 'execute_pwsh':
    case 'execute_bash':
    case 'execute_cmd': {
      const command = typeof data.command === 'string' ? data.command : '';
      return command
        ? `Running: ${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`
        : 'Running command';
    }
    case 'web_fetch':
      return 'Fetching web content';
    case 'remote_web_search':
    case 'web_search':
      return 'Searching the web';
    case 'subagent':
    case 'use_subagent':
      return 'Delegating work';
    default:
      return `Using ${toolName}`;
  }
}

export const kiroProvider: HookProvider = {
  kind: 'hook',
  id: KIRO_PROVIDER_ID,
  displayName: KIRO_DISPLAY_NAME,
  protocolVersion: 1,
  normalizeHookEvent: normalizeKiroHookEvent,
  installHooks: installKiroHooks,
  uninstallHooks: uninstallKiroHooks,
  areHooksInstalled: areKiroHooksInstalled,
  consentDisclosure: () => ({
    headline: 'Show Kiro CLI activity in the office?',
    disclosure:
      'Pixel Agents creates its own ~/.kiro/agents/pixel-agents-office.json profile and copies kiro-hook.js into ~/.pixel-agents/hooks/. Existing Kiro profiles and settings are left unchanged.\n\n' +
      'This profile sends session lifecycle, tool names, and tool inputs to the local Pixel Agents server. User prompt text and tool output are not sent. Kiro keeps its normal approval flow in the terminal.\n\n' +
      'Disable Instant Detection (Hooks) to remove the managed profile. Agents already running must be restarted to stop their hooks. You can also remove the managed profile manually.',
  }),
  formatToolStatus: formatKiroToolStatus,
  permissionExemptTools: KIRO_READING_TOOLS,
  // Kiro hooks expose delegation calls, not child lifecycle/identity. Keep the
  // office honest instead of inventing sub-agent or teammate characters.
  subagentToolNames: new Set(),
  readingTools: KIRO_READING_TOOLS,
  terminalNamePrefix: KIRO_DISPLAY_NAME,
  buildLaunchCommand: (sessionId, cwd) => {
    if (!areKiroHooksReady()) {
      throw new Error(
        'Enable Kiro Instant Detection (Hooks) in Settings before launching a Kiro agent.',
      );
    }
    return {
      command: resolveKiroExecutable(),
      args: ['chat', '--v3', '--agent', KIRO_AGENT_NAME],
      env: { [KIRO_SESSION_ENV]: sessionId, PWD: cwd },
    };
  },
};
