import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { OPENCODE_CONSENT_DISCLOSURE, OPENCODE_CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import { OPENCODE_PROVIDER_ID, OPENCODE_TERMINAL_NAME_PREFIX } from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './opencodeBridgeInstaller.js';

// ── formatToolStatus ──
//
// Status prefixes deliberately reuse the Claude vocabulary ("Reading x.ts",
// "Running: …", "Subtask: …"): the webview maps status → animation by prefix
// (webview-ui/src/office/toolUtils.ts), so sharing prefixes keeps every
// animation correct with no webview change.

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'read':
      return `Reading ${base(inp.path ?? inp.filePath)}`;
    case 'edit':
      return `Editing ${base(inp.filePath)}`;
    case 'write':
      return `Writing ${base(inp.filePath)}`;
    case 'bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '…' : cmd}`;
    }
    case 'glob':
      return 'Searching files';
    case 'grep':
      return 'Searching code';
    case 'webfetch':
      return 'Fetching web content';
    case 'websearch':
      return 'Searching the web';
    case 'task': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '…' : desc}`
        : 'Running subtask';
    }
    case 'skill': {
      const name = typeof inp.name === 'string' ? inp.name : '';
      return name ? `Using skill ${name}` : 'Using skill';
    }
    case 'question':
      return 'Waiting for your answer';
    case 'todowrite':
      return 'Updating todos';
    default:
      return `Using ${toolName}`;
  }
}

// ── buildLaunchCommand ──
//
// Reserved for a future "+ Agent" surface that launches OpenCode terminals:
// `opencode` starts a fresh session in the workspace directory. The sessionId
// is unused — OpenCode has no stable resume-by-id CLI flag to target — so the
// parameter is underscore-prefixed per the repo's noUnusedParameters policy.

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'opencode', args: [], env: { PWD: cwd } };
}

// ── normalizeHookEvent: the single OpenCode-specific normalization boundary ──
//
// The bridge plugin (bridge/pixel-agents-bridge.ts) already translates OpenCode
// bus events into this envelope vocabulary, so only THESE fields are read here
// and HERE ONLY. Downstream (hookEventHandler.ts) sees only the normalized
// AgentEvent union.
//
// `call_id` (the OpenCode tool call id) becomes the stable hook tool id, where
// Claude mints `hook-<Date.now()>` because its payload carries no id. A stable
// id is strictly better for Pre/Post correlation; the handler's 'current'
// sentinel path is untouched.
//
// Subagent envelopes (task calls carrying subagent_type) arrive as
// SubagentStart/SubagentStop with the subagent type as tool_name and the
// parent task's call_id as call_id. normalize maps the parent to
// `hook-<call_id>` — the same id the sibling PreToolUse path would have
// minted — so the handler's hook-fallback parent resolution correlates them
// without any JSONL. A missing call_id degrades to the 'current' sentinel,
// exactly like Claude.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;
  const callId = typeof raw.call_id === 'string' && raw.call_id.length > 0 ? raw.call_id : null;
  const toolId = callId ? `hook-${callId}` : `hook-${Date.now()}`;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: toolInput },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'SubagentStart': {
      const agentType = typeof raw.tool_name === 'string' ? raw.tool_name : 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: callId ? `hook-${callId}` : 'current',
          toolId: `hook-sub-${agentType}-${callId ?? Date.now()}`,
          toolName: agentType,
          input: raw.tool_input ?? {},
        },
      };
    }

    case 'SubagentStop':
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId: callId ? `hook-${callId}` : 'current',
          toolId: 'current',
        },
      };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
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

    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

/** Async so an installer throw always reaches callers as a rejection they can
 *  surface, never a sync throw. */
async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  await installerInstallHooks();
}

async function uninstallHooks(): Promise<void> {
  await installerUninstallHooks();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

/** This provider's first-run consent terms. The strings live in
 *  consentCopy.ts; the shared consent gate ships them verbatim. */
function consentDisclosure(): { headline: string; disclosure: string } {
  return { headline: OPENCODE_CONSENT_INSTALL_HEADLINE, disclosure: OPENCODE_CONSENT_DISCLOSURE };
}

// ── The provider ──
//
// Hooks-only: OpenCode persists sessions in a SQLite database
// (~/.local/share/opencode/opencode.db), not line-delimited transcripts, so
// there is no file fallback to implement — getSessionDirs,
// getAllSessionRoots, sessionFilePattern, and parseTranscriptLine are
// deliberately absent. Every state the office shows arrives over hooks.
//
// No team extension in the MVP: task subagents render as basic sub-agent
// characters via the handler's hook-fallback parent resolution.

export const opencodeProvider: HookProvider = {
  kind: 'hook',
  id: OPENCODE_PROVIDER_ID,
  displayName: 'OpenCode',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['task', 'question']),
  subagentToolNames: new Set(['task']),
  readingTools: new Set(['read', 'glob', 'grep', 'webfetch', 'websearch']),
  terminalNamePrefix: OPENCODE_TERMINAL_NAME_PREFIX,
  contextWindowForModel: undefined,

  buildLaunchCommand,
};
