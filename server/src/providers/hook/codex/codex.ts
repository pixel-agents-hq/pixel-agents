import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { CodexTailer } from './codexTailer.js';
import { CODEX_READING_TOOL_NAMES, CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

// ── formatToolStatus ──
//
// Codex's dominant tool is a general-purpose shell (`exec_command`); dedicated
// tools like `read_file`/`web_search` are comparatively rare. Falls back to the
// raw tool name for anything not special-cased, same as Claude's default arm.

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'exec_command':
    case 'shell': {
      const cmd = (inp.cmd as string) || (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '…' : cmd}`;
    }
    case 'apply_patch':
      return 'Editing files';
    case 'read_file':
      return `Reading ${typeof inp.path === 'string' ? inp.path : 'file'}`;
    case 'web_search':
      return 'Searching the web';
    case 'view_image':
      return 'Viewing image';
    default:
      return `Using ${toolName}`;
  }
}

// ── normalizeHookEvent ──
//
// All raw fields from our own codexTailer.ts payloads (tool_id, tool_name, cwd,
// transcript_path) are read HERE and HERE ONLY, mirroring claude.ts's boundary.
// The tailer defines this vocabulary itself (SessionStart/ExecStart/ExecEnd/
// TurnEnd/SessionEnd) since Codex has no hook-event names of its own to normalize.

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
        event: {
          kind: 'sessionStart',
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

    case 'ExecStart': {
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : `codex-${Date.now()}`;
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'exec_command';
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: raw.tool_input },
      };
    }

    case 'ExecEnd': {
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : 'current';
      return { sessionId, event: { kind: 'toolEnd', toolId } };
    }

    // Codex has no separate "went idle waiting for input" signal distinct from
    // "finished its turn" -- task_complete covers both, so awaitingInput is
    // always false here (renders as "Done", never "Waiting for input").
    case 'TurnEnd':
      return { sessionId, event: { kind: 'turnEnd' } };

    default:
      return null;
  }
}

// ── Installer: starts/stops the in-process JSONL tailer ──

let tailer: CodexTailer | null = null;

function installHooks(serverUrl: string, authToken: string): Promise<void> {
  if (!tailer) tailer = new CodexTailer(serverUrl, authToken);
  tailer.start();
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  tailer?.stop();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(tailer?.isRunning ?? false);
}

// ── The provider ──

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex CLI',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  // Codex has no built-in subagent/delegation concept exposed in the rollout
  // format today, so no tool is exempt from permission timers and none spawns
  // a sub-character. Revisit if/when Codex ships multi-agent delegation.
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: CODEX_READING_TOOL_NAMES,
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
};

/** Exposed for tests: reset the module-level tailer singleton between runs. */
export function __resetCodexTailerForTests(): void {
  tailer?.stop();
  tailer = null;
}
