/**
 * Web (REST) hook provider: a `HookProvider` driven purely by HTTP requests to
 * `POST /api/hooks/web`, so an agent character can be created and animated
 * with `curl` -- no CLI, no transcript file, no terminal.
 *
 * Deliberately thin: no file fallback (`getSessionDirs`/`parseTranscriptLine`/...),
 * no `team` extension, no fixed tool vocabulary. Any external caller can drive
 * this provider with its own tool names -- see docs/web-provider-plan.md.
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { WEB_PROVIDER_DISPLAY_NAME } from './constants.js';

/** Optional caller-supplied display-text override, carried through `input` so
 *  a free-form tool name doesn't have to fit any fixed `formatToolStatus`
 *  switch. Falls back to `Using ${toolName}` when absent. */
function withStatusOverride(
  input: Record<string, unknown> | undefined,
  status: unknown,
): Record<string, unknown> | undefined {
  if (typeof status !== 'string' || status.length === 0) return input;
  return { ...(input ?? {}), __statusText: status };
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const override = inp.__statusText;
  if (typeof override === 'string' && override.length > 0) return override;
  return `Using ${toolName}`;
}

function asString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
}

function asRecord(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = raw[key];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Normalize the web provider's wire payload onto `AgentEvent`.
 *
 * Wire shape (one schema, `hook_event_name` discriminates every in-scope kind --
 * see docs/web-provider-plan.md Phase 2a for the full table):
 *
 *   { session_id, hook_event_name, cwd?, reason?, awaiting_input?,
 *     parent_tool_id?, tool_id?, tool_name?, input?, status? }
 */
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'sessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: asString(raw, 'source'),
          // Web provider has no transcript files -- only `cwd` is used for
          // pending-session project-dir matching.
          transcriptPath: undefined,
          cwd: asString(raw, 'cwd'),
        },
      };

    case 'sessionEnd':
      return { sessionId, event: { kind: 'sessionEnd', reason: asString(raw, 'reason') } };

    case 'toolStart': {
      const toolId = asString(raw, 'tool_id');
      const toolName = asString(raw, 'tool_name');
      if (!toolId || !toolName) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: withStatusOverride(asRecord(raw, 'input'), raw.status),
        },
      };
    }

    case 'toolEnd': {
      const toolId = asString(raw, 'tool_id');
      if (!toolId) return null;
      return { sessionId, event: { kind: 'toolEnd', toolId } };
    }

    case 'turnEnd':
      return {
        sessionId,
        event: { kind: 'turnEnd', awaitingInput: raw.awaiting_input === true },
      };

    case 'permissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'subagentStart': {
      const parentToolId = asString(raw, 'parent_tool_id');
      const toolId = asString(raw, 'tool_id');
      const toolName = asString(raw, 'tool_name');
      if (!parentToolId || !toolId || !toolName) return null;
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId,
          toolId,
          toolName,
          input: withStatusOverride(asRecord(raw, 'input'), raw.status),
        },
      };
    }

    case 'subagentEnd': {
      const parentToolId = asString(raw, 'parent_tool_id');
      const toolId = asString(raw, 'tool_id');
      if (!parentToolId || !toolId) return null;
      return { sessionId, event: { kind: 'subagentEnd', parentToolId, toolId } };
    }

    // subagentTurnEnd (Agent Teams only) and progress (JSONL-only) have no
    // web-provider equivalent -- see docs/web-provider-plan.md Phase 2a.
    default:
      return null;
  }
}

// ── Installer: no-ops. There is nothing to install into -- the HTTP call
// itself *is* the hook. ──

function installHooks(): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(true);
}

export const webProvider: HookProvider = {
  kind: 'hook',
  id: 'web',
  displayName: WEB_PROVIDER_DISPLAY_NAME,
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  // Free-form tool vocabulary: unlike Claude's fixed built-in tools, any
  // external caller can be the client here, so nothing can be enumerated up
  // front. Callers wanting the "reading" animation can reuse Claude's tool
  // names (e.g. "Read", "Grep") -- clientMessageHandler unions capabilities
  // across the registry, so those still classify correctly.
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set<string>(),

  // No team extension, no file fallback (getSessionDirs, getAllSessionRoots,
  // sessionFilePattern, parseTranscriptLine, buildLaunchCommand,
  // terminalNamePrefix) -- deliberately omitted, see docs/web-provider-plan.md.
};
