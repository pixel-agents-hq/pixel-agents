import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { formatToolStatus as formatClaudeToolStatus } from '../claude/claude.js';

type JsonObject = Record<string, unknown>;

const OPERATION_KEYS = ['gen_ai.operation.name', 'operation.name', 'operationName'];
const SESSION_KEYS = [
  'copilot_chat.chat_session_id',
  'copilot_chat.session_id',
  'github.copilot.chat_session_id',
  'github.copilot.session_id',
  'gen_ai.conversation.id',
];
const MODEL_KEYS = ['gen_ai.request.model', 'gen_ai.response.model', 'model'];

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function attributes(raw: JsonObject): JsonObject {
  return object(raw.attributes ?? raw.attrs);
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(stringValue).find((value): value is string => value !== undefined);
}

export function extractSessionId(raw: JsonObject): string | undefined {
  const attrs = attributes(raw);
  return firstString(
    raw.session_id,
    raw.sessionId,
    raw.sid,
    ...SESSION_KEYS.map((key) => attrs[key]),
    attrs['session.id'],
    raw.traceId,
    object(raw.spanContext).traceId,
  );
}

export function extractModelName(raw: JsonObject): string | undefined {
  const attrs = attributes(raw);
  return firstString(...MODEL_KEYS.map((key) => attrs[key]), raw.modelName, raw.model);
}

export function extractWorkspacePath(raw: JsonObject): string | undefined {
  const attrs = attributes(raw);
  return firstString(
    raw.cwd,
    raw.workspacePath,
    attrs['github.copilot.workspace.path'],
    attrs['github.copilot.workspace_path'],
    attrs['copilot_chat.workspace_path'],
  );
}

function operation(raw: JsonObject): string | undefined {
  const attrs = attributes(raw);
  return firstString(...OPERATION_KEYS.map((key) => attrs[key])) ?? raw.type as string | undefined;
}

function spanId(raw: JsonObject): string {
  return (
    firstString(raw.spanId, object(raw.spanContext).spanId, raw.toolId) ??
    `otel-${Date.now()}`
  );
}

function parseInput(raw: JsonObject): JsonObject | undefined {
  const attrs = attributes(raw);
  const value =
    attrs['gen_ai.tool.call.arguments'] ??
    attrs['github.copilot.tool.call.arguments'] ??
    attrs['tool.input'] ??
    attrs['github.copilot.tool.parameters'];
  if (value && typeof value === 'object') return value as JsonObject;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return object(parsed);
    } catch {
      return { value };
    }
  }
  return undefined;
}

function rawToolName(raw: JsonObject): string {
  const attrs = attributes(raw);
  return (
    firstString(
      attrs['gen_ai.tool.name'],
      attrs['github.copilot.tool.name'],
      attrs['tool.name'],
      raw.toolName,
    ) ??
    raw.name?.toString().replace(/^execute_tool\s+/, '') ??
    'tool'
  );
}

export function mapToolName(name: string): string {
  const normalized = name.toLowerCase().replace(/[\s_-]+/g, '');
  if (/(readfile|getfile|openfile|cat|viewfile)/.test(normalized)) return 'Read';
  if (/(search|grep|findfile|glob|listdirectory|listfiles)/.test(normalized)) return 'Search';
  if (/(edit|writefile|createfile|applypatch|replace|stringreplace)/.test(normalized))
    return 'Edit';
  if (/(terminal|runcommand|executecommand|shell|bash|powershell)/.test(normalized))
    return 'Terminal';
  if (/(runsubagent|subagent|agent)/.test(normalized)) return 'Agent';
  return name;
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const mapped = mapToolName(toolName);
  const values = object(input);
  const target = firstString(
    values.filePath,
    values.file_path,
    values.path,
    values.command,
    values.query,
    values.pattern,
  );
  if (mapped === 'Read') return target ? `Reading ${target}` : 'Reading';
  if (mapped === 'Search') return target ? `Searching ${target}` : 'Searching';
  if (mapped === 'Edit') return target ? `Editing ${target}` : 'Editing';
  if (mapped === 'Terminal') return target ? `Running ${target}` : 'Running command';
  return formatClaudeToolStatus(mapped, input);
}

function event(
  sessionId: string,
  hookEventName: string,
  fields: JsonObject = {},
): JsonObject {
  return { hook_event_name: hookEventName, session_id: sessionId, ...fields };
}

/**
 * Turn one completed OTel/debug JSONL record into hook-shaped records. The file
 * exporter writes completed spans, so tool records intentionally produce both
 * lifecycle edges in order; the shared HookEventHandler still owns all UI state.
 */
export function parseOtelRecord(raw: JsonObject): JsonObject[] {
  const sessionId = extractSessionId(raw);
  if (!sessionId) return [];

  const debugType = stringValue(raw.type);
  const modelName = extractModelName(raw);
  if (debugType === 'session_start') {
    return [event(sessionId, 'SessionStart', { modelName, cwd: extractWorkspacePath(raw) })];
  }
  if (debugType === 'turn_start') return [event(sessionId, 'OtelTurnStart', { modelName })];
  if (debugType === 'turn_end') return [event(sessionId, 'OtelTurnEnd')];
  if (debugType === 'tool_call') {
    const toolId = spanId(raw);
    const toolName = rawToolName(raw);
    return [
      event(sessionId, 'OtelToolStart', {
        toolId,
        toolName: mapToolName(toolName),
        input: object(raw.attrs).args ?? parseInput(raw),
        modelName,
      }),
      event(sessionId, 'OtelToolEnd', { toolId }),
    ];
  }
  if (debugType === 'llm_request') {
    return modelName ? [event(sessionId, 'OtelModel', { modelName })] : [];
  }

  const op = operation(raw);
  if (op === 'invoke_agent') {
    return [
      event(sessionId, 'OtelTurnStart', { modelName, cwd: extractWorkspacePath(raw) }),
      event(sessionId, 'OtelTurnEnd'),
    ];
  }
  if (op === 'execute_tool') {
    const toolId = spanId(raw);
    const toolName = rawToolName(raw);
    return [
      event(sessionId, 'OtelToolStart', {
        toolId,
        toolName: mapToolName(toolName),
        input: parseInput(raw),
        modelName,
        cwd: extractWorkspacePath(raw),
      }),
      event(sessionId, 'OtelToolEnd', { toolId }),
    ];
  }
  if (op === 'chat' && modelName) return [event(sessionId, 'OtelModel', { modelName })];
  return [];
}

function normalizeHookEvent(
  raw: JsonObject,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = extractSessionId(raw);
  const name = stringValue(raw.hook_event_name);
  if (!sessionId || !name) return null;

  switch (name) {
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          cwd: stringValue(raw.cwd),
          modelName: stringValue(raw.modelName),
        },
      };
    case 'OtelTurnStart':
      return { sessionId, event: { kind: 'turnStart', modelName: stringValue(raw.modelName) } };
    case 'OtelTurnEnd':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'OtelModel': {
      const modelName = stringValue(raw.modelName);
      return modelName ? { sessionId, event: { kind: 'modelUpdate', modelName } } : null;
    }
    case 'OtelToolStart': {
      const toolName = stringValue(raw.toolName) ?? 'tool';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: stringValue(raw.toolId) ?? spanId(raw),
          toolName,
          input: object(raw.input),
        },
      };
    }
    case 'OtelToolEnd':
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: stringValue(raw.toolId) ?? 'current' },
      };
    default:
      return null;
  }
}

export const vscodeCopilotProvider: HookProvider = {
  kind: 'hook',
  id: 'vscode-copilot',
  displayName: 'VS Code Copilot',
  protocolVersion: 1,
  normalizeHookEvent,
  installHooks: async () => {},
  uninstallHooks: async () => {},
  areHooksInstalled: async () => true,
  consentDisclosure: () => ({
    headline: 'Use VS Code Copilot telemetry',
    disclosure:
      'Pixel Agents reads the OpenTelemetry JSONL file you configure for VS Code Copilot Chat.\n\n' +
      'No Copilot hooks, CLI, or settings files are modified.',
  }),
  formatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(['Agent', 'runSubagent']),
  readingTools: new Set(['Read', 'Search']),
};
