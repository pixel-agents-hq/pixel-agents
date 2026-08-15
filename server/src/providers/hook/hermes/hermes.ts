import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import {
  HERMES_LARGE_CONTEXT_WINDOW,
  HERMES_SMALL_CONTEXT_MODEL_PATTERN,
  HERMES_SMALL_CONTEXT_WINDOW,
  HERMES_TERMINAL_NAME_PREFIX,
} from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './hermesHookInstaller.js';

// ── formatToolStatus ─────────────────────────────────────────
//
// Hermes tool names are snake_case (unlike Claude's PascalCase). The webview
// renders read-like tools with the "reading" animation and everything else as
// "typing", so classifying the read family here keeps the office character
// legible without webview edits.

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + '\u2026' : s;

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');

  switch (toolName) {
    case 'terminal': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return `Running: ${truncate(cmd, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
    }
    case 'read_file':
      return `Reading ${base(inp.path)}`;
    case 'write_file':
      return `Writing ${base(inp.path)}`;
    case 'patch': {
      // patch accepts either a single path or a V4A multi-file patch whose
      // `path` is an array of files.
      const p = inp.path;
      const names = Array.isArray(p) ? p.map(base).filter(Boolean) : [base(p)];
      return `Editing ${names.join(', ')}`;
    }
    case 'search_files':
      return 'Searching files';
    case 'web_search':
      return 'Searching the web';
    case 'web_extract':
      return 'Extracting web content';
    case 'execute_code':
      return 'Running code';
    case 'browser_exec':
      return 'Browsing the web';
    case 'skill_view': {
      const name = typeof inp.name === 'string' ? inp.name : '';
      return name ? `Loading skill: ${name}` : 'Loading skill';
    }
    case 'computer_use':
      return 'Controlling the computer';
    case 'delegate_task': {
      const goal = typeof inp.goal === 'string' ? inp.goal : '';
      return goal
        ? `Subtask: ${truncate(goal, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}`
        : 'Running subtask';
    }
    default:
      return `Using ${toolName}`;
  }
}

// ── normalizeHookEvent: the single Hermes-specific normalization boundary ──
//
// All raw Hermes outbound-webhook payload fields (hook_event_name,
// tool_name, tool_input, session_id, cwd, extra) are read HERE and HERE ONLY.
// Downstream (hookEventHandler.ts) sees only the normalized AgentEvent union.
//
// Hermes wire format (agent/outbound_webhooks.py) matches the Claude hook
// payload shape, so the same sentinel conventions apply: 'current' toolIds for
// PostToolUse/SubagentStop (the raw payload carries no id; the handler
// correlates via its own currentHookToolId state) and synthetic hook-* ids for
// tool starts.
//
// Event-name gaps (v2): Hermes has no permissionRequest event — approvals are
// surfaced as an interactive CLI prompt, never a hook. A future permission
// surface should map to the permissionRequest AgentEvent.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  // Helper to read the `extra` bag that carries event-specific kwargs.
  const extra = (): Record<string, unknown> =>
    typeof raw.extra === 'object' && raw.extra !== null
      ? (raw.extra as Record<string, unknown>)
      : {};

  switch (eventName) {
    case 'pre_tool_call': {
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
        },
      };
    }

    case 'post_tool_call':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'on_turn_complete':
      // Hermes finished its turn and is now idle waiting on the user.
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };

    case 'on_session_start': {
      const e = extra();
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof e.platform === 'string' ? e.platform : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    }

    case 'on_session_end': {
      const e = extra();
      const reason =
        e.interrupted === true ? 'interrupted' : e.completed === true ? 'completed' : undefined;
      return { sessionId, event: { kind: 'sessionEnd', reason } };
    }

    case 'subagent_start': {
      const e = extra();
      const role = typeof e.child_role === 'string' ? e.child_role : 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hook-sub-${role}-${Date.now()}`,
          toolName: role,
          input: raw,
        },
      };
    }

    case 'subagent_stop':
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'current' },
      };

    // gateway_platform_event (Telegram/Discord reactions, edits, …) and
    // on_session_finalize (session cleanup) are informational/duplicate for
    // character lifecycle — on_session_end already removes the agent. Drop.
    case 'gateway_platform_event':
    case 'on_session_finalize':
    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

function installHooks(serverUrl: string, authToken: string): Promise<void> {
  installerInstallHooks(serverUrl, authToken);
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  installerUninstallHooks();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

// ── Context windows ──────────────────────────────────────────

/**
 * Window a Hermes model's context is measured against.
 *
 * Hermes reports the model id on every session-start payload but never the
 * limit, so this table is a best-effort denominator for the context gauge.
 * Unknown ids return undefined so the runtime keeps whatever it already
 * assumed rather than adopting a fresh guess.
 */
export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model || model === '<synthetic>') return undefined;
  return HERMES_SMALL_CONTEXT_MODEL_PATTERN.test(model)
    ? HERMES_SMALL_CONTEXT_WINDOW
    : HERMES_LARGE_CONTEXT_WINDOW;
}

// ── The provider ──

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set(['delegate_task']),
  subagentToolNames: new Set(['delegate_task']),
  readingTools: new Set([
    'read_file',
    'search_files',
    'web_search',
    'web_extract',
    'session_search',
    'skill_view',
  ]),
  terminalNamePrefix: HERMES_TERMINAL_NAME_PREFIX,
  contextWindowForModel,

  // Intentionally omitted (Hermes sessions live in SQLite, not JSONL): the
  // file-fallback surface (getSessionDirs / getAllSessionRoots /
  // sessionFilePattern / parseTranscriptLine) and the TeamProvider. Hermes
  // subagents are delegate_task runs, normalized as subagentStart/subagentEnd
  // with no team semantics — no team handler is needed.
};
