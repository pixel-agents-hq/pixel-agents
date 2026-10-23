/**
 * HermesProvider — the second HookProvider after Claude Code.
 *
 * The integration surface with Hermes is its built-in outbound-webhook
 * subsystem (`hooks.outbound` in config.yaml, fired by
 * `agent/outbound_webhooks.py`): lifecycle events are POSTed as
 *
 *   { hook_event_name, profile, tool_name, tool_input, session_id, cwd,
 *     extra: { ...event kwargs... }, delivery_id, timestamp }
 *
 * — deliberately the same snake_case field names as Claude's hook payloads at
 * the top level, but with the event names and the per-event extras shaped by
 * Hermes (`agent/shell_hooks.py::_payload_fields` is the wire definition).
 * All Hermes-specific reading happens HERE and only here; downstream sees the
 * normalized AgentEvent union like every other provider.
 *
 * Notable normalization decisions, with their reasons:
 *  - `on_session_end` fires PER TURN on the Hermes side (run_conversation()
 *    runs once per user message; the event is emitted from
 *    `agent/turn_finalizer.py`), so it maps to `turnEnd`, not `sessionEnd`.
 *    The real session close is `on_session_finalize`.
 *  - Approval events normalize to `permissionRequest` /
 *    `permissionResolved`: `_fire_approval_hook` forwards the bound session
 *    id into the envelope's top level (routable), and an approval site
 *    without a bound session posts an empty id — dropped by the guard below,
 *    never a bubble without an owner.
 *  - Hermes sub-agents (delegate_task children) are separate top-level
 *    sessions whose store rows carry parent_session_id — but the wire
 *    envelope never does (`_payload_fields` resolves the child's own id and
 *    drops the parent). So the session-STORE SCANNER correlates them and
 *    renders each as a Subtask sub-character near its lead via the
 *    scanner-only subagent_session_start/end events (Claude's shape, store's
 *    facts). Their wire lifecycle events stay dropped by
 *    HERMES_SILENT_PLATFORMS: full characters would double-render a
 *    delegation, and silence would make children vanish — the sub-character
 *    path is what makes them neither.
 *  - Unattended platform surfaces (cron/batch) are filtered out at the
 *    sessionStart gate so scheduled runs cannot flood the office; the filter
 *    is only expressible on the events that carry `platform` (session
 *    lifecycle), which is sufficient because a session that never became
 *    pending has no agent to receive its later tool events either.
 */

import * as crypto from 'crypto';
import * as path from 'path';

import type {
  AgentEvent,
  HookProvider,
  SessionScannerContext,
} from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import {
  HERMES_SCANNER_SUBAGENT_END_EVENT,
  HERMES_SCANNER_SUBAGENT_START_EVENT,
  HERMES_SCANNER_SUGGESTION_LIMIT,
  HERMES_SILENT_PLATFORMS,
  HERMES_TERMINAL_NAME_PREFIX,
} from './constants.js';
import {
  areHooksInstalled,
  getHermesHome,
  hermesHomeExists,
  installHooks,
  uninstallHooks,
} from './hermesHookInstaller.js';
import { createHermesSessionScanner, subagentStatusLabel } from './hermesSessionScanner.js';
import { openHermesStore } from './hermesSessionStore.js';

// ── formatToolStatus ─────────────────────────────────────────
// Hermes tool names (snake_case, from the shipped toolsets). Unknown tools
// degrade to "Using <tool>" exactly like the Claude provider does.

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) =>
    typeof p === 'string' && p ? path.win32.basename(p.replace(/\\/g, '/')) : '';
  const firstArg = (v: unknown, max: number) => {
    const s = Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  };
  switch (toolName) {
    case 'read_file':
      return `Reading ${base(inp.path)}`;
    case 'write_file':
      return `Writing ${base(inp.path)}`;
    case 'patch':
      return `Editing ${base(inp.path)}`;
    case 'search_files':
      return inp.target === 'files' ? 'Searching files' : 'Searching code';
    case 'terminal': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'execute_code':
      return 'Running code';
    case 'web_search':
      return 'Searching the web';
    case 'web_extract':
      return `Fetching ${firstArg(inp.urls, 40) || 'web content'}`;
    case 'browser_exec':
      return 'Driving the browser';
    case 'session_search':
      return 'Searching past sessions';
    case 'skill_view':
      return 'Reading a skill';
    case 'skill_manage':
      return 'Writing a skill';
    case 'delegate_task': {
      const desc = firstArg(
        inp.goal ?? inp.description ?? inp.task,
        BASH_COMMAND_DISPLAY_MAX_LENGTH,
      );
      return desc ? `Subtask: ${desc}` : 'Running subtask';
    }
    default:
      return `Using ${toolName}`;
  }
}

// ── normalizeHookEvent: the Hermes-specific normalization boundary ──

function extraOf(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.extra && typeof raw.extra === 'object' ? (raw.extra as Record<string, unknown>) : {};
}

/** Platform as the wire knows it: lifecycle/human-input events carry it in
 *  `extra`; tool-call events don't carry it at all (undefined). Only a
 *  POSITIVE match against the silent set drops an event. */
function platformOf(raw: Record<string, unknown>): string | undefined {
  const p = extraOf(raw).platform;
  return typeof p === 'string' && p ? p : undefined;
}

function isSilentSession(raw: Record<string, unknown>): boolean {
  const p = platformOf(raw);
  return p !== undefined && HERMES_SILENT_PLATFORMS.has(p);
}

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * Context-gauge snapshot from on_session_end's `usage` / `context_length`.
 *
 * Hermes' canonical usage carries `prompt_tokens` (input + cache reads + cache
 * writes) and `completion_tokens`; their sum is the same figure the transcript
 * path derives per assistant record for Claude. A turn that never reached an
 * API response posts `usage: null` (and a Hermes without the per-turn snapshot
 * posts nothing at all), so we only speak when the numbers sum — silence means
 * "leave the gauge alone", never a fabricated zero.
 */
function contextUsageFromExtra(
  extra: Record<string, unknown>,
): { contextTokens: number; maxContextTokens?: number } | undefined {
  const usage = extra.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const contextTokens =
    (positiveInt(u.prompt_tokens) ?? 0) + (positiveInt(u.completion_tokens) ?? 0);
  if (contextTokens <= 0) return undefined;
  const maxContextTokens = positiveInt(extra.context_length);
  return maxContextTokens ? { contextTokens, maxContextTokens } : { contextTokens };
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  // Hermes' envelope builder (`_payload_fields`) resolves the top-level
  // session_id from kwargs.session_id/parent_session_id and falls back to ''
  // when an event carries only a session_key — those events (agent_loop_stopped,
  // approval sites fired without a bound observability context) are not
  // routable to an agent, and a stale or hand-edited subscription must still
  // drop cleanly here rather than mint an agent for session "".
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || sessionId === '')
    return null;

  switch (eventName) {
    case 'pre_tool_call': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        raw.tool_input && typeof raw.tool_input === 'object'
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      const extra = extraOf(raw);
      // Hermes hands the real tool_call_id through extra (Claude only learns
      // it later via JSONL polling, hence its synthetic hook-* ids). We pass
      // it through as-is: the handler maintains its own correlation id for
      // the toolEnd 'current' sentinel, so this value's job is diagnostics —
      // but it is the honest one and costs nothing.
      const toolId =
        typeof extra.tool_call_id === 'string' && extra.tool_call_id
          ? extra.tool_call_id
          : `hook-${Date.now()}`;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: toolInput,
          // Hermes' background flag is `background` (terminal tool), not
          // Claude's `run_in_background`.
          runInBackground: toolInput.background === true,
        },
      };
    }

    case 'post_tool_call':
      // Success, error, and blocked results all normalize identically (same
      // contract as Claude's PostToolUse/PostToolUseFailure collapse).
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'pre_approval_request':
      // The dangerous-command / edit-approval gate is waiting on a human.
      // Same visual contract as Claude's PermissionRequest hook.
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'post_approval_response':
      // The human answered (approve/deny/timeout — all of them resolve the
      // gate). Claude has no matching hook: its JSONL watcher broadcasts the
      // clear when the tool_result lands. A push-only provider must carry the
      // resolution itself, or the bubble would hang until the turn's
      // agentToolsClear.
      return { sessionId, event: { kind: 'permissionResolved' } };

    case 'on_session_end': {
      // Fires per turn after the tool loop (turn_finalizer). interrupted /
      // failed turns end visually like Done: Hermes' retry/queue machinery
      // has no "stuck, bubble the user" analogue beyond the approval and
      // human-input events, which arrive as their own permissionRequest /
      // awaitingInput signals before this turn end.
      if (isSilentSession(raw)) return null;
      // Hermes also pushes the turn's context snapshot on this event: the last
      // API response's canonical token totals plus the window its compressor
      // resolved. This provider has no transcript to poll, so without these
      // numbers the gauge would never move.
      const usage = contextUsageFromExtra(extraOf(raw));
      return {
        sessionId,
        event: usage ? { kind: 'turnEnd', usage } : { kind: 'turnEnd' },
      };
    }

    case 'on_human_input_request':
      // A tool is blocked on the human (clarify-style input, MCP elicitation,
      // vault payment). Mirrors Claude's Notification(idle_prompt): the turn
      // is over and the character visibly waits. The matching resolved event
      // is not subscribed — the next tool/turn event clears the bubble, same
      // as Claude.
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };

    case 'on_session_start': {
      if (isSilentSession(raw)) return null;
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          // source discriminates /clear-style reassignment for Claude; Hermes
          // /new fires on_session_reset (not subscribed: it carries only the
          // NEW session_id, and the new session fires its own
          // on_session_start on the next turn, so reset itself needs no
          // routing). Every start here is a plain session open.
          source: 'startup',
          // Hermes has no per-session transcript path in the envelope and this
          // provider ships no file fallback, so the adoption path uses cwd
          // (top-level, process cwd at fire time) for Directory matching.
          transcriptPath: undefined,
          cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined,
        },
      };
    }

    case 'on_session_finalize':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason:
            typeof extraOf(raw).platform === 'string'
              ? (extraOf(raw).platform as string)
              : undefined,
        },
      };

    case HERMES_SCANNER_SUBAGENT_START_EVENT: {
      // Scanner-internal only (hermesSessionScanner correlates children via
      // sessions.parent_session_id — the WIRE never carries the mapping). The
      // top-level session_id is the PARENT (routing target); the child's own
      // session id keys its sub-character chip so parallel delegates each
      // render separately. Guarded like any wire junk all the same: a stray
      // POST of this name must fail closed, not mint a parentless character.
      const childId = typeof raw.subagent_session_id === 'string' ? raw.subagent_session_id : '';
      if (!childId) return null;
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hermes-sub-${childId}`,
          toolName: subagentStatusLabel(
            typeof raw.subagent_title === 'string' ? raw.subagent_title : '',
          ),
          input: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined,
        },
      };
    }

    case HERMES_SCANNER_SUBAGENT_END_EVENT: {
      // The child retired; the handler resolves exactly WHICH sub-character
      // (stable toolId) and clears the whole parent group when the last one
      // lands. A malformed delivery falls back to the group-level 'current'
      // sentinel, mirroring the wire's post_tool_call collapse.
      const childId = typeof raw.subagent_session_id === 'string' ? raw.subagent_session_id : '';
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId: 'current',
          toolId: childId ? `hermes-sub-${childId}` : 'current',
        },
      };
    }

    // Everything else — including unsubscribed-by-design events and their
    // stale/hand-edited deliveries — drops gracefully, like Claude's
    // UserPromptSubmit case.
    default:
      return null;
  }
}

// ── Installer wrappers ───────────────────────────────────────

async function install(serverUrl: string, authToken: string): Promise<void> {
  await installHooks(serverUrl, authToken);
}

async function uninstall(): Promise<void> {
  await uninstallHooks();
}

function installed(): Promise<boolean> {
  return Promise.resolve(areHooksInstalled());
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return { headline: CONSENT_INSTALL_HEADLINE, disclosure: CONSENT_DISCLOSURE };
}

// ── buildLaunchCommand: spawning `hermes` from the office ─────────

/** Hermes session ids are a validated upstream contract (hermes_state_ids
 *  .new_session_id / is_known_session_id): `<YYYYmmdd_HHMMSS>_<6 hex>`, local
 *  clock. A raw uuid would be REJECTED by the Hermes CLI, so we mint in that
 *  shape and hand it back via the returned sessionId — the launcher registers
 *  it and the on_session_start hook of the spawned process carries it
 *  verbatim, closing the correlation loop without any transcript file. */
function mintHermesSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

function buildLaunchCommand(
  _candidateSessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string>; sessionId: string } {
  const sessionId = mintHermesSessionId();
  const args = ['chat', '--session-id', sessionId];
  // Hermes' analogue of Claude's --dangerously-skip-permissions.
  if (opts?.bypassPermissions) args.push('--yolo');
  // The bare name is intentional: resolveLaunchCommand absolutises it on
  // Windows (node-pty there cannot spawn bare PATH names) and POSIX resolves
  // it in posix_spawnp. The office launches whichever `hermes` the server's
  // PATH holds — the same binary the operator's terminal would run.
  return { command: 'hermes', args, env: { PWD: cwd }, sessionId };
}

// ── The provider ─────────────────────────────────────────────

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes Agent',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks: install,
  uninstallHooks: uninstall,
  areHooksInstalled: installed,
  consentDisclosure,

  // Availability: a Hermes data home on disk. The consent gate and the
  // capabilities broadcast skip unavailable providers so machines that never
  // ran Hermes are never asked about it (a declined/hidden Hermes row is
  // re-offered for free the moment Hermes appears on the next server start).
  // SYNC stat — see HookProvider.isAvailable for why.
  isAvailable: hermesHomeExists,

  formatToolStatus,
  // Hermes' approvals ride the routable pre_approval_request hook, so the
  // timer-driven fallback below is only a backstop. The exempt set stops the
  // permission timer chasing tools that never gate: delegate_task renders
  // Subtask sub-characters instead of permission bubbles, and
  // clarify/react_to_message are Hermes' user-blocking tools and surface
  // through on_human_input_request instead of the office's permission bubble.
  permissionExemptTools: new Set(['delegate_task', 'clarify', 'react_to_message']),
  // delegate_task IS the sub-agent-spawning tool. Children fire their own
  // lifecycle on the wire (dropped: HERMES_SILENT_PLATFORMS) and are rendered
  // from the store's parent↔child rows as Subtask sub-characters (see the
  // session scanner) — the same visual contract Claude's Task/Agent produce.
  // The handler suppresses the bare tool bubble for these names and the
  // sub-character machinery takes over for the whole delegation.
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

  // ── The heuristic surface, store-shaped ──────────────────────────
  // Hermes keeps sessions in ONE SQLite database (`<home>/state.db`) plus a
  // JSON lease registry — there is no per-workspace transcript directory, so
  // the JSONL-shaped members (getSessionDirs / getAllSessionRoots /
  // sessionFilePattern / parseTranscriptLine) are deliberately NOT
  // registered: a file scanner pointed at the home would mis-adopt the
  // emergency diversion JSONLs as junk characters, and push-only launch
  // registration already tolerates their absence (see the launcher). The
  // CAPABILITIES those members encode for Claude do exist here, and ship as:
  //  - createSessionScanner: hook-less adoption + liveness reaping + child
  //    correlation, reading state.db / active_sessions.json and driving the
  //    ordinary hook pipeline with transition events (the parseTranscriptLine
  //    equivalent is the messages-table replay in hermesSessionScanner);
  //  - directorySuggestions: the "worked in here recently" list straight from
  //    the sessions table, the getAllSessionRoots-walk equivalent.
  createSessionScanner: (ctx: SessionScannerContext) => createHermesSessionScanner(ctx),

  // Desktop-gateway rows carry `cwd = NULL` and Hermes has no transcript file,
  // so the scanner's birth sessionStart arrives path-less. Without this opt-in
  // the transient-session gate in hookEventHandler drops it before pending
  // staging, the confirm beat finds an unknown session, and the desk stays
  // empty forever (the cwd-NULL invisibility defect). Directory/Watch-All
  // policy is enforced unchanged at confirmation time (onExternalSessionDetected).
  stagesPathlessSessions: true,

  directorySuggestions(): { cwd: string; lastActiveMs: number }[] {
    // Short-lived open/close: the modal asks rarely, and pinning a read-only
    // handle across the app's lifetime buys nothing. Any failure (no store,
    // no sqlite builtin, locked file) yields no suggestions — never a throw.
    const store = openHermesStore(getHermesHome());
    if (!store) return [];
    try {
      return store.listDirectorySuggestions(HERMES_SCANNER_SUGGESTION_LIMIT);
    } finally {
      try {
        store.close();
      } catch {
        /* already gone */
      }
    }
  },

  // It CAN launch them:
  buildLaunchCommand,
};
