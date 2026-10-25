import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveConfiguredSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';

const PROVIDER_ID = 'openclaw';
const API_PATH = `/api/hooks/${PROVIDER_ID}`;
const REQUEST_TIMEOUT_MS = 2_000;
const TURN_END_DELAY_MS = 100;
const SERVER_DIR = join(homedir(), '.pixel-agents');
const REGISTRY_DIR = join(SERVER_DIR, 'servers');
const LEGACY_SERVER_FILE = join(SERVER_DIR, 'server.json');
const REMOTE_TOKEN_PATH = 'plugins.entries.pixel-agents-openclaw.config.remote.token';

const turnEndTimers = new Map<string, ReturnType<typeof setTimeout>>();

function opaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function sessionId(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): string | null {
  const value =
    context.sessionKey ?? context.sessionId ?? event.sessionKey ?? event.sessionId ?? context.runId;
  return typeof value === 'string' && value ? opaqueId(value) : null;
}

function toolId(
  event: { toolCallId?: string; toolName: string },
  context: Record<string, unknown>,
  id: string,
): string {
  const value =
    typeof event.toolCallId === 'string' && event.toolCallId
      ? event.toolCallId
      : `${id}:${event.toolName}:${context.runId ?? 'tool'}`;
  return opaqueId(value);
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverTarget(value: unknown): { port: number; pid: number; token: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.port === 'number' &&
    typeof record.pid === 'number' &&
    typeof record.token === 'string' &&
    record.token
    ? { port: record.port, pid: record.pid, token: record.token }
    : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function pixelAgentServers(): Array<{ port: number; pid: number; token: string }> {
  const servers: Array<{ port: number; pid: number; token: string }> = [];
  try {
    for (const name of readdirSync(REGISTRY_DIR)) {
      if (!name.endsWith('.json')) continue;
      const target = serverTarget(readJson(join(REGISTRY_DIR, name)));
      if (target && isLiveProcess(target.pid)) servers.push(target);
    }
  } catch {
    // The registry is optional; old Pixel Agents releases use server.json.
  }
  if (servers.length > 0) return servers;
  const legacy = serverTarget(readJson(LEGACY_SERVER_FILE));
  return legacy && isLiveProcess(legacy.pid) ? [legacy] : [];
}

interface RelayTarget {
  endpoint: string;
  token: string;
}

interface PluginRuntimeApi {
  pluginConfig?: Record<string, unknown>;
  runtime: { config: { current(): Record<string, unknown> } };
  logger: { warn(message: string): void };
}

function remoteEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '::1' || url.hostname.startsWith('127.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname.replace(/\/$/, '') !== API_PATH) return null;
    url.pathname = API_PATH;
    return url.toString();
  } catch {
    return null;
  }
}

async function configuredRemoteTarget(api: PluginRuntimeApi): Promise<RelayTarget | null> {
  const remote = api.pluginConfig?.remote;
  if (!remote || typeof remote !== 'object') return null;
  const record = remote as Record<string, unknown>;
  const endpoint = remoteEndpoint(record.endpoint);
  if (!endpoint) {
    api.logger.warn(
      `pixel-agents: remote.endpoint must be the final ${API_PATH} URL and use HTTPS (HTTP is allowed only for loopback)`,
    );
    return null;
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: api.runtime.config.current(),
    env: process.env,
    value: record.token,
    path: REMOTE_TOKEN_PATH,
  });
  if (!resolved.value) {
    api.logger.warn('pixel-agents: remote relay token is unavailable; remote delivery is disabled');
    return null;
  }
  return { endpoint, token: resolved.value };
}

async function send(target: RelayTarget, body: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
      },
      body,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch {
    // Visualization must never affect the agent run.
  } finally {
    clearTimeout(timeout);
  }
}

function eventSender(api: PluginRuntimeApi): (event: Record<string, unknown>) => Promise<void> {
  const localDiscovery = api.pluginConfig?.localDiscovery !== false;
  const remote = configuredRemoteTarget(api);
  return async (event) => {
    const body = JSON.stringify(event);
    const targets: RelayTarget[] = localDiscovery
      ? pixelAgentServers().map((server) => ({
          endpoint: `http://127.0.0.1:${server.port}${API_PATH}`,
          token: server.token,
        }))
      : [];
    const remoteTarget = await remote;
    if (remoteTarget) targets.push(remoteTarget);
    await Promise.all(targets.map((target) => send(target, body)));
  };
}

async function announceSession(
  postEvent: (event: Record<string, unknown>) => Promise<void>,
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<string | null> {
  const id = sessionId(event, context);
  if (!id) return null;
  await postEvent({
    event: 'session_start',
    session_id: id,
    source: 'openclaw',
    ...(typeof context.workspaceDir === 'string' ? { cwd: context.workspaceDir } : {}),
  });
  return id;
}

function cancelTurnEnd(id: string): void {
  const timer = turnEndTimers.get(id);
  if (timer) clearTimeout(timer);
  turnEndTimers.delete(id);
}

function scheduleTurnEnd(
  id: string,
  postEvent: (event: Record<string, unknown>) => Promise<void>,
): void {
  cancelTurnEnd(id);
  const timer = setTimeout(() => {
    turnEndTimers.delete(id);
    void postEvent({ event: 'turn_end', session_id: id });
  }, TURN_END_DELAY_MS);
  timer.unref?.();
  turnEndTimers.set(id, timer);
}

export default definePluginEntry({
  id: 'pixel-agents-openclaw',
  name: 'Pixel Agents OpenClaw Relay',
  description: 'Sends content-free lifecycle events to local or remote Pixel Agents servers.',
  register(api) {
    const postEvent = eventSender(api);
    api.on('model_call_started', async (event, context) => {
      const id = await announceSession(postEvent, event, context);
      if (id) cancelTurnEnd(id);
    });

    api.on('model_call_ended', async (event, context) => {
      const id = sessionId(event, context);
      if (id) scheduleTurnEnd(id, postEvent);
    });

    api.on('before_tool_call', async (event, context) => {
      const id = await announceSession(postEvent, event, context);
      if (!id) return;
      cancelTurnEnd(id);
      await postEvent({
        event: 'tool_start',
        session_id: id,
        tool_id: toolId(event, context, id),
        tool_name: event.toolName,
      });
    });

    api.on('after_tool_call', async (event, context) => {
      const id = sessionId(event, context);
      if (!id) return;
      await postEvent({ event: 'tool_end', session_id: id, tool_id: toolId(event, context, id) });
    });

    api.on('session_end', async (event, context) => {
      const id = sessionId(event, context);
      if (!id) return;
      cancelTurnEnd(id);
      await postEvent({
        event: 'session_end',
        session_id: id,
        ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
      });
    });

    api.on('gateway_stop', async () => {
      for (const timer of turnEndTimers.values()) clearTimeout(timer);
      turnEndTimers.clear();
    });
  },
});
