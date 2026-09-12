/**
 * Codex provider.
 *
 * Codex's hook surface is close enough to Claude Code's that this is mostly a
 * name-mapping exercise, with three real differences worth calling out:
 *
 *  1. Tool names differ entirely. Codex's shell is `exec_command`, its editor is
 *     `apply_patch`, and MCP tools arrive under their server-qualified names.
 *     The read/write classification below drives the reading-vs-typing
 *     animation, so it is the one table worth getting right.
 *
 *  2. Codex carries a real `tool_use_id` on PreToolUse AND PostToolUse. The
 *     Claude provider returns a sentinel 'current' for PostToolUse because its
 *     payload lacks the id; we can correlate properly instead.
 *
 *  3. Codex has no Agent Teams equivalent, so `team` is left unset. Its
 *     SubagentStart/SubagentStop still map to sub-agent characters.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './codexHookInstaller.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import {
  CODEX_CONFIG_DIR,
  CODEX_CONTEXT_WINDOW_PATTERNS,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  CODEX_DISPLAY_NAME,
  CODEX_PROVIDER_ID,
  CODEX_TERMINAL_NAME_PREFIX,
  SHELL_COMMAND_DISPLAY_MAX_LENGTH,
} from './constants.js';

// ── Tool classification ──────────────────────────────────────────────
//
// Verified against real rollout transcripts rather than guessed: Codex reports
// exec_command / apply_patch / update_plan / view_image / request_user_input /
// write_stdin, plus MCP tools under their own names.

/** Tools that should render the "reading" animation instead of "typing". */
const READING_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'grep',
  'file_search',
  'view_image',
  'read_thread_terminal',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'list_apps',
]);

/** Tools that never trigger the permission-wait timer: they either cannot
 *  prompt, or their whole purpose is to wait on the user (in which case the
 *  turnEnd/permissionRequest events already say so). */
const PERMISSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'update_plan',
  'view_image',
  'read_file',
  'list_dir',
  'grep',
  'file_search',
  'request_user_input',
]);

/** Tools that spawn sub-agent characters. Codex has no Task/Agent tool; the
 *  SubagentStart hook is the only signal, so this stays empty rather than
 *  guessing a name that would silently never match. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

  switch (toolName) {
    case 'exec_command': {
      // Codex reports the command as a string or an argv array depending on the
      // call site; handle both rather than rendering "[object Object]".
      const raw = inp['command'];
      const cmd = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '';
      return cmd ? `Running: ${clip(cmd, SHELL_COMMAND_DISPLAY_MAX_LENGTH)}` : 'Running a command';
    }
    case 'write_stdin':
      return 'Typing into a command';
    case 'apply_patch': {
      // The patch body embeds the paths; show the first one rather than the diff.
      const patch = typeof inp['patch'] === 'string' ? (inp['patch'] as string) : '';
      const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
      const file = m ? path.basename(m[1].trim()) : base(inp['path'] ?? inp['file_path']);
      return file ? `Editing ${file}` : 'Editing files';
    }
    case 'read_file':
      return `Reading ${base(inp['path'] ?? inp['file_path'])}` || 'Reading a file';
    case 'list_dir':
      return 'Listing files';
    case 'grep':
    case 'file_search':
      return 'Searching code';
    case 'view_image':
      return 'Looking at an image';
    case 'update_plan':
      return 'Updating the plan';
    case 'request_user_input':
      return 'Waiting for your answer';
    case 'read_thread_terminal':
      return 'Reading terminal output';
    default:
      // MCP tools arrive as `server__tool` or `server.tool`; show just the tool
      // half, which is the part that means anything to a watcher.
      const short = toolName.split(/__|\./).pop() ?? toolName;
      return `Using ${short}`;
  }
}

// ── Session dirs + launch command ────────────────────────────────────

/** Codex stores rollouts at ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl —
 *  date-sharded and NOT keyed by workspace, so we cannot narrow by path the way
 *  the Claude provider does. Returning the day dirs would make the watcher scan
 *  every project's sessions, so file fallback is deliberately not offered:
 *  hooks are the supported path for this provider. */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), CODEX_CONFIG_DIR, 'sessions')];
}

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args: string[] = [];
  // Codex has no --session-id flag; it mints its own id and reports it on
  // SessionStart, which is how the runtime learns it.
  if (opts?.bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
  return { command: 'codex', args, env: { PWD: cwd } };
}

function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  // Longest pattern first so `gpt-4.1` cannot be shadowed by a shorter match.
  const sorted = [...CODEX_CONTEXT_WINDOW_PATTERNS].sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, window] of sorted) {
    if (m.includes(pattern)) return window;
  }
  // Any gpt-5*/codex* id gets the default window; an unrecognized family
  // returns undefined so the runtime keeps its own estimate.
  return m.includes('codex') || m.includes('gpt-5') ? CODEX_DEFAULT_CONTEXT_WINDOW : undefined;
}

// ── normalizeHookEvent: the single Codex-specific normalization boundary ──
//
// Every raw Codex field (tool_name, tool_input, agent_id, …) is read HERE and
// HERE ONLY. Downstream sees the normalized AgentEvent union.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw['hook_event_name'];
  const sessionId = raw['session_id'];
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const toolName = str(raw['tool_name']);
  const toolInput =
    typeof raw['tool_input'] === 'object' && raw['tool_input'] !== null
      ? (raw['tool_input'] as Record<string, unknown>)
      : undefined;
  // Codex carries a real id on both Pre- and PostToolUse, so unlike the Claude
  // provider we never need a 'current' sentinel for tool correlation.
  const toolUseId = str(raw['tool_use_id']);

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: str(raw['source']) || undefined,
          transcriptPath: str(raw['transcript_path']) || undefined,
          cwd: str(raw['cwd']) || undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: str(raw['reason']) || undefined },
      };

    case 'PreToolUse': {
      if (!toolName) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: toolUseId || `hook-${Date.now()}`,
          toolName,
          input: toolInput,
        },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      // Without an id there is nothing to correlate; 'current' is the handler's
      // agreed sentinel for "whatever tool is open on this session".
      return { sessionId, event: { kind: 'toolEnd', toolId: toolUseId || 'current' } };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Stop':
      // Codex's Stop means the turn finished. It has no Notification(idle_prompt)
      // equivalent, so `awaitingInput` stays unset: the office shows "Done"
      // rather than inventing a distinction the payload does not carry.
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'SubagentStart': {
      const agentId = str(raw['agent_id']);
      if (!agentId) return null;
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: toolUseId || 'current',
          toolId: agentId,
          toolName: str(raw['agent_type']) || 'subagent',
          input: toolInput,
        },
      };
    }

    case 'SubagentStop': {
      const agentId = str(raw['agent_id']);
      if (!agentId) return null;
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: toolUseId || 'current', toolId: agentId },
      };
    }

    default:
      // Unknown or deliberately-uninstalled event (UserPromptSubmit, PreCompact,
      // Interrupt, …). Returning null is the documented "ignore this" contract.
      return null;
  }
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: CODEX_PROVIDER_ID,
  displayName: CODEX_DISPLAY_NAME,
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks: installerInstallHooks,
  uninstallHooks: installerUninstallHooks,
  areHooksInstalled: installerAreHooksInstalled,

  consentDisclosure: () => ({
    headline: CONSENT_INSTALL_HEADLINE,
    disclosure: CONSENT_DISCLOSURE,
  }),

  formatToolStatus,
  permissionExemptTools: PERMISSION_EXEMPT_TOOLS,
  subagentToolNames: SUBAGENT_TOOL_NAMES,
  readingTools: READING_TOOLS,
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,

  contextWindowForModel,
  isPresent: codexLooksInstalled,
  getAllSessionRoots,
  buildLaunchCommand,
};

/**
 * True when Codex looks installed for this user.
 *
 * Checks for ~/.codex rather than the binary on PATH: the directory is what we
 * would be editing, it appears on Codex's first run, and a PATH probe would miss
 * the many ways a CLI is installed while costing a process spawn on every
 * handshake. A user with the directory but no binary is asked once and simply
 * sees nothing happen — the harmless direction to be wrong in.
 */
export function codexLooksInstalled(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), CODEX_CONFIG_DIR));
  } catch {
    return false;
  }
}
