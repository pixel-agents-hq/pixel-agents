/**
 * Orca provider constants.
 *
 * Orca is a hierarchical multi-agent IDE that normalizes 17 CLI vendors into one
 * event stream and (Source A) pushes it to `POST /api/hooks/orca`. This provider
 * is a pure translation layer — it never talks to Orca, it only maps Orca's
 * already-normalized payloads onto pixel-agents' AgentEvent union.
 *
 * See docs/orca-integration.md (§10 push contract, §6 data-model mapping).
 */

export const ORCA_PROVIDER_ID = 'orca';
export const ORCA_DISPLAY_NAME = 'Orca';

/** The 17 CLI agent types Orca's relay normalizes (one `POST /hook/<type>` each). */
export const ORCA_AGENT_TYPES = [
  'amp',
  'antigravity',
  'claude',
  'codex',
  'command-code',
  'copilot',
  'cursor',
  'devin',
  'droid',
  'gemini',
  'grok',
  'hermes',
  'kimi',
  'mimo-code',
  'omp',
  'opencode',
  'pi',
] as const;

export type OrcaAgentType = (typeof ORCA_AGENT_TYPES)[number];

export const ORCA_AGENT_TYPE_SET: ReadonlySet<string> = new Set(ORCA_AGENT_TYPES);

/**
 * Orca's normalized event vocabulary — the `hook_event_name` values the forwarder
 * sends. `session.start`/`agent.start`/`tool.call`/`tool.result`/`assistant.message`/
 * `agent.end` come straight from the relay; `session.end`/`permission.request` are
 * accepted for the push contract (turn end / decision gate).
 */
export const ORCA_EVENT = {
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
  AGENT_START: 'agent.start',
  AGENT_END: 'agent.end',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  ASSISTANT_MESSAGE: 'assistant.message',
  PERMISSION_REQUEST: 'permission.request',
} as const;

/** Orca per-agent lifecycle state (from the relay's `state` model). */
export const ORCA_STATE = {
  WORKING: 'working',
  IDLE: 'idle',
  DONE: 'done',
} as const;

/** ptyId = `<sessionUuid>::<workspaceAbsPath>@@<agentShortHash>`. */
export const ORCA_PTYID_WORKSPACE_SEP = '::';
export const ORCA_PTYID_HASH_SEP = '@@';

// ── Cross-CLI tool-name buckets ─────────────────────────────
// Best-effort across 17 vendors (varied casing / naming); refined in M4/M5 with
// real payloads. Under Source A (push) hookDelivered is always set, so the
// permission-exempt set is largely inert (heuristic timers are suppressed).

export const ORCA_READING_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'read',
  'Grep',
  'grep',
  'Glob',
  'glob',
  'Search',
  'search',
  'WebFetch',
  'fetch',
  'WebSearch',
  'web_search',
  'List',
  'list',
  'ls',
  'Cat',
  'cat',
  'View',
  'view',
]);

export const ORCA_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  'spawn',
  'delegate',
  'subagent',
]);

export const ORCA_PERMISSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ...ORCA_READING_TOOLS,
  'Task',
  'Agent',
]);
