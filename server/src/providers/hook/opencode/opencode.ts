/**
 * OpenCode HookProvider.
 *
 * OpenCode is a server-based AI agent runtime (opencode.ai). Unlike CLI-based
 * tools such as Claude Code, OpenCode runs as a persistent server and exposes
 * a REST API and SSE event stream.
 *
 * This provider receives normalized webhook payloads from the escal-ai wrapper
 * bridge, which subscribes to OpenCode's `/global/event` SSE stream and
 * translates each event into the format expected by `normalizeHookEvent`.
 *
 * Because OpenCode is server-based:
 *   - No hook scripts to install (install/uninstall are no-ops).
 *   - No file fallback (OpenCode uses a database, not JSONL transcript files).
 *   - `buildLaunchCommand` delegates to the wrapper API.
 */

import type { HookProvider } from '../../../../../core/src/provider.js';
import { normalizeOpenCodeHookEvent, formatToolStatus } from './opencode.webhook.js';
import {
  OPENCODE_TERMINAL_NAME_PREFIX,
  OPENCODE_READING_TOOLS,
  OPENCODE_SUBAGENT_TOOLS,
  OPENCODE_PERMISSION_EXEMPT_TOOLS,
} from './opencode-constants.js';

// ── Provider ──

export const opencodeProvider: HookProvider = {
  kind: 'hook',
  id: 'opencode',
  displayName: 'OpenCode',
  protocolVersion: 1,

  normalizeHookEvent: normalizeOpenCodeHookEvent,

  installHooks: async () => {},
  uninstallHooks: async () => {},
  areHooksInstalled: async () => true,

  formatToolStatus,
  permissionExemptTools: OPENCODE_PERMISSION_EXEMPT_TOOLS,
  subagentToolNames: OPENCODE_SUBAGENT_TOOLS,
  readingTools: OPENCODE_READING_TOOLS,
  terminalNamePrefix: OPENCODE_TERMINAL_NAME_PREFIX,

  // No file fallback — OpenCode is server-based, no JSONL transcripts.
  getSessionDirs: undefined,
  getAllSessionRoots: undefined,
  sessionFilePattern: undefined,
  parseTranscriptLine: undefined,

  // Launch command: delegates to the wrapper API to start a new OpenCode session.
  buildLaunchCommand: (
    _sessionId: string,
    cwd: string,
    _opts?: { bypassPermissions?: boolean },
  ) => ({
    command: 'curl',
    args: [
      '-X', 'POST',
      'http://wrapper:8000/task',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ title: `pixel-agent-${Date.now()}`, description: '' }),
      '--max-time', '30',
    ],
    env: { PWD: cwd },
  }),
};
