/**
 * Orca HookProvider — pure translation of Orca's normalized event stream into
 * pixel-agents' AgentEvent union. No live Orca connection: Orca (Source A) pushes
 * to `POST /api/hooks/orca` and this maps each payload.
 *
 * The single Orca-specific normalization boundary is normalizeHookEvent; downstream
 * (hookEventHandler.ts) sees only AgentEvent. agent_type / ptyId workspace / state
 * are read HERE. See docs/orca-integration.md §10 (push contract) + §6 (mapping).
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import {
  ORCA_AGENT_TYPE_SET,
  ORCA_DISPLAY_NAME,
  ORCA_EVENT,
  ORCA_PERMISSION_EXEMPT_TOOLS,
  ORCA_PROVIDER_ID,
  ORCA_PTYID_HASH_SEP,
  ORCA_PTYID_WORKSPACE_SEP,
  ORCA_READING_TOOLS,
  ORCA_STATE,
  ORCA_SUBAGENT_TOOLS,
} from './constants.js';

/**
 * Extract the workspace absolute path from an Orca ptyId
 * (`<sessionUuid>::<workspaceAbsPath>@@<agentShortHash>`). Returns undefined if the
 * id isn't in that shape. Windows paths (with a `C:` drive) survive because we split
 * on the first `::` (the uuid never contains one) and the last `@@`.
 */
export function parseOrcaWorkspacePath(ptyId: string): string | undefined {
  const sep = ptyId.indexOf(ORCA_PTYID_WORKSPACE_SEP);
  if (sep === -1) return undefined;
  const afterUuid = ptyId.slice(sep + ORCA_PTYID_WORKSPACE_SEP.length);
  const at = afterUuid.lastIndexOf(ORCA_PTYID_HASH_SEP);
  const ws = at === -1 ? afterUuid : afterUuid.slice(0, at);
  return ws || undefined;
}

/**
 * The agent's CLI type ('codex', 'cursor', ...) for an Orca event, if present and
 * recognized. Consumed at adoption (M4) to tag the AgentState so the office renders
 * the type badge. Unknown/absent → undefined (falls back to the default at render).
 */
export function orcaAgentTypeFromEvent(raw: Record<string, unknown>): string | undefined {
  const t = raw.agent_type;
  return typeof t === 'string' && ORCA_AGENT_TYPE_SET.has(t) ? t : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Best-effort, cross-CLI tool status. Orca surfaces tool names from 17 vendors with
 * varied casing, so we match on normalized substrings rather than exact names.
 */
export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const basename = (p: unknown): string => {
    const s = str(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  };
  const name = toolName.toLowerCase();
  const target = basename(inp.file_path ?? inp.path ?? inp.filename ?? inp.file);

  if (/read|cat|view|open/.test(name)) return target ? `Reading ${target}` : 'Reading';
  if (/edit|write|apply|patch|create|modify/.test(name))
    return target ? `Editing ${target}` : 'Editing';
  if (/bash|shell|exec|run|command|terminal/.test(name)) {
    const cmd = str(inp.command ?? inp.cmd ?? inp.script);
    return cmd ? `Running: ${truncate(cmd, BASH_COMMAND_DISPLAY_MAX_LENGTH)}` : 'Running command';
  }
  if (/grep|search|find/.test(name)) return 'Searching code';
  if (/glob|list|ls\b/.test(name)) return 'Searching files';
  if (/fetch|web|http|url|browse/.test(name)) return 'Fetching web content';
  if (/task|agent|spawn|delegate|subagent/.test(name)) return 'Running subtask';
  return `Using ${toolName}`;
}

/**
 * Map an Orca payload onto an AgentEvent.
 *
 * Dispatch:
 *  - `session.start`                 → sessionStart (cwd from raw.cwd or the ptyId)
 *  - `tool.call`                     → toolStart (name/input from `tool`)
 *  - `tool.result`                   → toolEnd ('current' — handler correlates)
 *  - `permission.request`            → permissionRequest (decision gate)
 *  - `session.end` / `agent.end`     → sessionEnd
 *  - anything else (agent.start,     → driven by `state`: done → sessionEnd,
 *    assistant.message, ...)            idle → turnEnd(awaitingInput), working → drop
 *
 * The forwarder therefore signals turn-end/idle via a `state: 'idle'` event
 * (mirroring Claude's separate PostToolUse→Stop), not by piggybacking on tool.result.
 */
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const kind = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : '';
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
  if (!kind || !sessionId) return null;

  const state = typeof raw.state === 'string' ? raw.state : undefined;
  const tool =
    typeof raw.tool === 'object' && raw.tool !== null
      ? (raw.tool as Record<string, unknown>)
      : undefined;

  switch (kind) {
    case ORCA_EVENT.SESSION_START:
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : parseOrcaWorkspacePath(sessionId),
        },
      };

    case ORCA_EVENT.TOOL_CALL: {
      const toolName = typeof tool?.name === 'string' ? tool.name : '';
      const toolInput =
        typeof tool?.input === 'object' && tool.input !== null
          ? (tool.input as Record<string, unknown>)
          : {};
      const toolId = String(tool?.id ?? raw.tool_id ?? toolName ?? 'tool');
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: toolInput,
          runInBackground: toolInput.run_in_background === true,
        },
      };
    }

    case ORCA_EVENT.TOOL_RESULT:
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case ORCA_EVENT.PERMISSION_REQUEST:
      return { sessionId, event: { kind: 'permissionRequest' } };

    case ORCA_EVENT.SESSION_END:
    case ORCA_EVENT.AGENT_END:
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : ORCA_STATE.DONE,
        },
      };

    default:
      // agent.start / assistant.message / unrecognized: lifecycle by state.
      if (state === ORCA_STATE.DONE) {
        return { sessionId, event: { kind: 'sessionEnd', reason: ORCA_STATE.DONE } };
      }
      if (state === ORCA_STATE.IDLE) {
        return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
      }
      return null; // working / no lifecycle change — tools drive the active state
  }
}

// ── Installer no-ops ──
// Orca's integration is push-based: the forwarder lives in Orca (added per §10),
// not installed by pixel-agents. There is nothing for us to install/uninstall.

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(false);
}

// ── The provider ──

export const orcaProvider: HookProvider = {
  kind: 'hook',
  id: ORCA_PROVIDER_ID,
  displayName: ORCA_DISPLAY_NAME,
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: ORCA_PERMISSION_EXEMPT_TOOLS,
  subagentToolNames: ORCA_SUBAGENT_TOOLS,
  readingTools: ORCA_READING_TOOLS,
  // No team (M5), no file fallback (push-only), no terminal launch.
};
