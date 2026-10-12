// Managed by Pixel Agents — bridge plugin that reports OpenCode session activity
// to a local Pixel Agents server so your agents appear as characters in the
// office. Safe to delete: removing this file uninstalls the integration.
// Installed by Pixel Agents (never hand-edit; reinstall to refresh).

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Server discovery (mirrors the claude-hook.js registry protocol) ─────────
// Every live server registers one record under ~/.pixel-agents/servers/; a
// legacy single-target ~/.pixel-agents/server.json is the fallback. Records
// carry { port, pid, token } — validated minimally here so a foreign or
// half-written file can never divert an event (or the bearer token) elsewhere.

const PIXEL_AGENTS_DIR = path.join(os.homedir(), '.pixel-agents');
const SERVERS_REGISTRY_DIR = path.join(PIXEL_AGENTS_DIR, 'servers');
const LEGACY_SERVER_JSON = path.join(PIXEL_AGENTS_DIR, 'server.json');
const HOOK_API_PATH = '/api/hooks/opencode';
const POST_TIMEOUT_MS = 2000;

interface ServerTarget {
  port: number;
  pid: number;
  token: string;
}

let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];

function bridgeDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} OPENCODE-BRIDGE ${line}\n`);
  } catch {
    /* never let diagnostics break the bridge */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asServerTarget(value: unknown): ServerTarget | null {
  if (!isRecord(value)) return null;
  const { port, pid, token } = value;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  return { port: port as number, pid: pid as number, token };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRegistry(): ServerTarget[] {
  let files: string[];
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const live: ServerTarget[] = [];
  for (const file of files) {
    try {
      const target = asServerTarget(
        JSON.parse(fs.readFileSync(path.join(SERVERS_REGISTRY_DIR, file), 'utf-8')),
      );
      if (!target) continue;
      if (isProcessAlive(target.pid)) live.push(target);
    } catch {
      /* malformed entry: skip */
    }
  }
  return live;
}

function postToServer(server: ServerTarget, body: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: HOOK_API_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: POST_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('error', () => resolve());
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch {
      resolve();
    }
  });
}

/** Best-effort fan-out. Fire-and-forget: callers must `void` this, never
 *  await it — awaiting would stall the tool call or session transition that
 *  fired the event while the POST is in flight. */
function emit(envelope: Record<string, unknown>): void {
  const sid =
    typeof envelope['session_id'] === 'string'
      ? (envelope['session_id'] as string).slice(0, 8)
      : '?';
  const eventName =
    typeof envelope['hook_event_name'] === 'string' ? (envelope['hook_event_name'] as string) : '?';
  bridgeDebug(`emit event=${eventName} sid=${sid}`);
  let servers = readRegistry();
  if (servers.length === 0) {
    try {
      const legacy = asServerTarget(JSON.parse(fs.readFileSync(LEGACY_SERVER_JSON, 'utf-8')));
      servers = legacy && isProcessAlive(legacy.pid) ? [legacy] : [];
    } catch {
      servers = [];
    }
  }
  if (servers.length === 0) {
    bridgeDebug(`exit reason=no-server-json event=${eventName} sid=${sid}`);
    return;
  }
  const body = JSON.stringify(envelope);
  void Promise.all(servers.map((server) => postToServer(server, body)));
}

// ── OpenCode event → hook envelope ───────────────────────────────────────────
// The envelope reuses the hook vocabulary the server route already accepts
// (hook_event_name + session_id, see server/src/httpServer.ts), so the
// OpenCode provider normalizes these exactly like Claude hook payloads.

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Last session seen on any event. Permission prompts do not always carry a
 *  session id, so they fall back to this rather than being dropped. */
let lastSessionId: string | undefined;

function trackSession(sessionId: string | undefined): string | undefined {
  if (sessionId) lastSessionId = sessionId;
  return sessionId;
}

function sessionStart(info: Record<string, unknown>): void {
  const sessionId = trackSession(str(info['id']));
  if (!sessionId) return;
  emit({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'opencode',
    cwd: str(info['directory']),
  });
}

function sessionEnd(info: Record<string, unknown>): void {
  const sessionId = trackSession(str(info['id']));
  if (!sessionId) return;
  emit({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'exit' });
}

function toolBefore(input: Record<string, unknown>): void {
  const tool = str(input['tool']);
  const sessionId = trackSession(str(input['sessionID']));
  if (!tool || !sessionId) return;
  const args = record(input['args']);
  const callId = str(input['callID']);
  const subagentType = str(args['subagent_type']);
  if (tool === 'task' && subagentType) {
    emit({
      hook_event_name: 'SubagentStart',
      session_id: sessionId,
      tool_name: subagentType,
      tool_input: { description: str(args['description']), call_id: callId },
      call_id: callId,
    });
    return;
  }
  emit({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: tool,
    tool_input: args,
    call_id: callId,
  });
}

function toolAfter(input: Record<string, unknown>, output: Record<string, unknown>): void {
  const tool = str(input['tool']);
  const sessionId = trackSession(str(input['sessionID']));
  if (!tool || !sessionId) return;
  const args = record(input['args']);
  const callId = str(input['callID']);
  const metadata = record(output['metadata']);
  const exitCode = metadata['exit'];
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  const subagentType = str(args['subagent_type']);
  if (tool === 'task' && subagentType) {
    emit({ hook_event_name: 'SubagentStop', session_id: sessionId, call_id: callId });
    return;
  }
  emit({
    hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
    session_id: sessionId,
    call_id: callId,
  });
}

function permissionPrompt(input: Record<string, unknown>): void {
  const sessionId = trackSession(str(input['sessionID'])) ?? lastSessionId;
  if (!sessionId) return;
  emit({ hook_event_name: 'PermissionRequest', session_id: sessionId });
}

// ── Plugin ───────────────────────────────────────────────────────────────────
// One named export, the shape OpenCode's plugin loader calls with its context.
// Handlers stay synchronous and fire-and-forget: nothing here may delay the
// tool call or session transition being reported.
//
// Event keys follow the documented OpenCode plugin events. `permission.ask`
// is kept as an alias next to the documented `permission.asked`: unknown keys
// are inert (OpenCode only invokes handlers for events it fires), while a
// renamed key without its alias would silently lose the permission bubble.

export const PixelAgents = async () => ({
  'session.created': (input: Record<string, unknown>) => {
    sessionStart(record(input['info']));
  },
  'session.deleted': (input: Record<string, unknown>) => {
    sessionEnd(record(input['info']));
  },
  'session.idle': (input: Record<string, unknown>) => {
    const sessionId = trackSession(str(input['sessionID']));
    if (!sessionId) return;
    emit({ hook_event_name: 'Stop', session_id: sessionId });
  },
  'tool.execute.before': (input: Record<string, unknown>) => {
    toolBefore(input);
  },
  'tool.execute.after': (input: Record<string, unknown>, output: Record<string, unknown>) => {
    toolAfter(input, output ?? {});
  },
  'permission.asked': (input: Record<string, unknown>) => {
    permissionPrompt(input);
  },
  'permission.ask': (input: Record<string, unknown>) => {
    permissionPrompt(input);
  },
});
