import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

function sessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function currentSessionDir(): string {
  const now = new Date();
  return path.join(
    sessionsRoot(),
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
}

function getSessionDirs(_workspacePath: string): string[] {
  return [currentSessionDir()];
}

function getAllSessionRoots(): string[] {
  return [sessionsRoot()];
}

function buildLaunchCommand(
  _sessionId: string,
  _cwd: string,
  _opts?: { bypassPermissions?: boolean },
): { command: string; args: string[] } {
  return { command: findCodexExecutable(), args: [] };
}

function findCodexExecutable(): string {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'codex';
}

function parseArguments(input?: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseTranscriptLine(line: string): AgentEvent | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.type !== 'string') return null;

  if (
    record.type === 'response_item' &&
    (payload.type === 'function_call' || payload.type === 'custom_tool_call')
  ) {
    const toolName = typeof payload.name === 'string' ? payload.name : 'tool';
    const callId =
      typeof payload.call_id === 'string'
        ? payload.call_id
        : `codex-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
      kind: 'toolStart',
      toolId: callId,
      toolName,
      input:
        payload.type === 'custom_tool_call'
          ? ((payload.input ?? {}) as Record<string, unknown>)
          : parseArguments(payload.arguments),
    };
  }

  if (
    record.type === 'response_item' &&
    (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
  ) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    if (!callId) return null;
    return { kind: 'toolEnd', toolId: callId };
  }

  if (record.type === 'response_item' && payload.type === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : '';
    if (role === 'assistant') return { kind: 'turnEnd' };
  }

  return null;
}

export function formatCodexToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'shell_command': {
      const command = typeof inp.command === 'string' ? inp.command : '';
      return command
        ? `Running: ${command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : command}`
        : 'Running command';
    }
    case 'apply_patch':
      return 'Editing files';
    case 'update_plan':
      return 'Updating plan';
    case 'view_image':
      return 'Inspecting image';
    case 'read_mcp_resource':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return 'Reading connected resource';
    default:
      return `Using ${toolName}`;
  }
}

function normalizeHookEvent(
  _raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  return null;
}

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(false);
}

export function findNewestCodexSessionFile(afterMs: number, cwd?: string): string | null {
  const root = sessionsRoot();
  const candidates: Array<{ file: string; mtime: number; cwdMatches: boolean }> = [];
  const expectedCwd = cwd ? path.resolve(cwd).toLowerCase() : undefined;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= afterMs) {
            const sessionCwd = readLatestCwd(full);
            const cwdMatches =
              expectedCwd !== undefined &&
              sessionCwd !== null &&
              path.resolve(sessionCwd).toLowerCase() === expectedCwd;
            candidates.push({ file: full, mtime: stat.mtimeMs, cwdMatches });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  walk(root);
  candidates.sort((a, b) => {
    if (a.cwdMatches !== b.cwdMatches) return a.cwdMatches ? -1 : 1;
    return b.mtime - a.mtime;
  });
  return candidates[0]?.file ?? null;
}

function readLatestCwd(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    const readSize = Math.min(stat.size, 128 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const payload = record.payload as Record<string, unknown> | undefined;
        const cwd = payload?.cwd;
        if (record.type === 'turn_context' && typeof cwd === 'string') return cwd;
      } catch {
        /* ignore malformed tail line */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,
  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus: formatCodexToolStatus,
  permissionExemptTools: new Set(['update_plan']),
  subagentToolNames: new Set(),
  readingTools: new Set([
    'shell_command',
    'view_image',
    'read_mcp_resource',
    'list_mcp_resources',
    'list_mcp_resource_templates',
  ]),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  parseTranscriptLine,
  buildLaunchCommand,
};
