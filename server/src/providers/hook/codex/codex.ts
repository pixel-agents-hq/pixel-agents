import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { formatToolStatus as claudeFormatToolStatus } from '../claude/claude.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './codexHookInstaller.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

// ── normalizeHookEvent: the single Codex-specific normalization boundary ──
//
// Codex's hooks system is experimental and only fires 5 events (SessionStart,
// PreToolUse/PostToolUse restricted to Bash, UserPromptSubmit, Stop). The
// payload shares the `hook_event_name` / `session_id` / `cwd` / `transcript_path`
// field names Claude Code uses, so this maps to the same normalized AgentEvent
// union with no new event kinds. There is no subagent, file-write, notification,
// or session-end coverage on Codex today -- those AgentEvents are simply never
// emitted for Codex sessions.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'Bash';
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
        },
      };
    }

    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'UserPromptSubmit':
      // No normalized kind for user prompts yet; silently ignore.
      return null;

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

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
//
// Codex has no transcript files pixel-agents can poll (no heuristic fallback),
// no Agent Teams equivalent, and no subagent lifecycle -- so getSessionDirs,
// buildLaunchCommand, and `team` are all omitted rather than stubbed.

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  // Reused verbatim: Codex's only tool event is Bash, and Claude's formatToolStatus
  // already renders "Running: <command>" for it.
  formatToolStatus: claudeFormatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
};
