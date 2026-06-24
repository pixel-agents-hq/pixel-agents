import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './claudeHookInstaller.js';
import { claudeTeamProvider } from './claudeTeamProvider.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from './constants.js';

// ── formatToolStatus: moved from src/transcriptParser.ts ──

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Bash': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return 'Editing notebook';
    case 'TeamCreate': {
      const teamName = typeof inp.team_name === 'string' ? inp.team_name : '';
      return teamName ? `Creating team: ${teamName}` : 'Creating team';
    }
    case 'SendMessage': {
      const recipient = typeof inp.recipient === 'string' ? inp.recipient : '';
      return recipient ? `-> ${recipient}` : 'Sending message';
    }
    default:
      return `Using ${toolName}`;
  }
}

// ── Session dir + launch command ──

function getSessionDirs(workspacePath: string): string[] {
  // Claude stores sessions at ~/.claude/projects/<workspace-path-with-dashes>/.
  const dirName = normalizeProjectPath(workspacePath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);

  // Try exact match first.
  if (fs.existsSync(projectDir)) return [projectDir];

  // Case-insensitive fallback for Windows: drive letter casing can differ
  // between what VS Code gives us (e.g. "c:\...") and Claude's encoding ("C:\...").
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (fs.existsSync(projectsRoot)) {
      const lowerDirName = dirName.toLowerCase();
      const match = fs.readdirSync(projectsRoot).find((c) => c.toLowerCase() === lowerDirName);
      if (match) return [path.join(projectsRoot, match)];
    }
  } catch {
    /* ignore scan errors */
  }

  // Return the expected path even if it doesn't exist yet (caller tolerates missing dirs).
  return [projectDir];
}

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args = ['--session-id', sessionId];
  if (opts?.bypassPermissions) args.push('--dangerously-skip-permissions');
  return { command: 'claude', args, env: { PWD: cwd } };
}

/** Root that holds every Claude session across all workspaces. Used by the
 *  global session scanner ("Watch All Sessions"). */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.claude', 'projects')];
}

// ── normalizeHookEvent: the single Claude-specific normalization boundary ──
//
// All raw Claude hook payload fields (tool_name, tool_input, agent_type, etc.) are
// read HERE and HERE ONLY. Downstream (hookEventHandler.ts) sees only the normalized
// AgentEvent union.
//
// Sentinel 'current' toolIds are returned for PostToolUse/SubagentStop because the
// raw hook payload doesn't carry the id; the handler correlates using its own
// currentHookToolId state. Synthetic hook-* ids are returned for PreToolUse because
// the real tool id arrives later via JSONL polling.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
          runInBackground: toolInput.run_in_background === true,
        },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'UserPromptSubmit':
      // No normalized kind for user prompts yet; silently ignore.
      return null;

    case 'SubagentStart': {
      const agentType = typeof raw.agent_type === 'string' ? raw.agent_type : 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hook-sub-${agentType}-${Date.now()}`,
          toolName: agentType,
          input: raw,
          runInBackground: raw.run_in_background === true,
        },
      };
    }

    case 'SubagentStop':
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'current' },
      };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Notification': {
      const notificationType =
        typeof raw.notification_type === 'string' ? raw.notification_type : '';
      if (notificationType === 'permission_prompt') {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      if (notificationType === 'idle_prompt') {
        // idle_prompt = Claude went idle waiting on the user, not just a finished
        // turn. awaitingInput drives the "Waiting for input" label (vs "Done" for Stop).
        return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
      }
      return null;
    }

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    // Agent Teams: a teammate went idle / marked a task complete. Normalize as
    // `subagentTurnEnd` so the team handler can route by agent_type to the teammate.
    // `reason` discriminates the two so handlers don't read raw eventName.
    case 'TeammateIdle':
      return {
        sessionId,
        event: { kind: 'subagentTurnEnd', parentToolId: 'current', reason: 'idle' },
      };
    case 'TaskCompleted':
      return {
        sessionId,
        event: { kind: 'subagentTurnEnd', parentToolId: 'current', reason: 'completed' },
      };

    // TaskCreated is informational; no AgentEvent shape fits it. Drop.
    case 'TaskCreated':
    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

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

// ── The provider ──

export const claudeProvider: HookProvider = {
  kind: 'hook',
  id: 'claude',
  displayName: 'Claude Code',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),
  subagentToolNames: new Set(['Task', 'Agent']),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: CLAUDE_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,

  team: claudeTeamProvider,
};
