import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  getPreparedPluginSecretInput,
  resolveConfiguredSecretInputString,
} from 'openclaw/plugin-sdk/secret-input-runtime';
import { SessionActivityAggregator } from './sessionActivity.js';

const PROVIDER_ID = 'openclaw';
const API_PATH = `/api/hooks/${PROVIDER_ID}`;
const REQUEST_TIMEOUT_MS = 2_000;
const SERVER_DIR = join(homedir(), '.pixel-agents');
const REGISTRY_DIR = join(SERVER_DIR, 'servers');
const LEGACY_SERVER_FILE = join(SERVER_DIR, 'server.json');
const REMOTE_TOKEN_PATH = 'plugins.entries.pixel-agents-openclaw.config.remote.token';

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
  return opaqueId(`${id}:${value}`);
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
  const prepared = getPreparedPluginSecretInput('pixel-agents-openclaw', 'remote.token');
  const resolved = prepared.value
    ? prepared
    : await resolveConfiguredSecretInputString({
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
  return async (event) => {
    const body = JSON.stringify(event);
    const targets: RelayTarget[] = localDiscovery
      ? pixelAgentServers().map((server) => ({
          endpoint: `http://127.0.0.1:${server.port}${API_PATH}`,
          token: server.token,
        }))
      : [];
    // Resolve inside an active hook, after the Gateway has published its
    // prepared secret snapshot. Never cache an unavailable startup value;
    // retries and credential rotations must be visible to subsequent events.
    const remoteTarget = await configuredRemoteTarget(api);
    if (remoteTarget) targets.push(remoteTarget);
    await Promise.all(targets.map((target) => send(target, body)));
  };
}

function hookContext(
  api: PluginRuntimeApi,
  context: Record<string, unknown>,
): Record<string, unknown> {
  // Model/tool hooks can carry agentId without workspaceDir. Recover only the
  // configured workspace identity, never transcripts or source content.
  const agents = api.runtime.config.current().agents as
    | {
        defaults?: { workspace?: string };
        entries?: Record<
          string,
          { workspace?: string; name?: string; identity?: { name?: string } }
        >;
        list?: Array<{
          id: string;
          workspace?: string;
          name?: string;
          identity?: { name?: string };
        }>;
      }
    | undefined;
  const agentId =
    typeof context.agentId === 'string'
      ? context.agentId
      : typeof context.sessionKey === 'string'
        ? /^agent:([^:]+):/.exec(context.sessionKey)?.[1]
        : undefined;
  const entry = agentId
    ? (agents?.entries?.[agentId] ?? agents?.list?.find((a) => a.id === agentId))
    : undefined;
  const workspaceDir = context.workspaceDir ?? entry?.workspace ?? agents?.defaults?.workspace;
  const overrides = api.pluginConfig?.agentNames as Record<string, string> | undefined;
  const displayName = agentId
    ? overrides?.[agentId] || entry?.identity?.name || entry?.name || agentId
    : undefined;
  const namespace =
    typeof api.pluginConfig?.gatewayId === 'string'
      ? api.pluginConfig.gatewayId
      : `${hostname()}:${process.env.OPENCLAW_STATE_DIR ?? homedir()}:${process.env.OPENCLAW_CONFIG_PATH ?? ''}`;
  // Ordinary chats share an agent. Genuine delegated child sessions remain
  // distinct; do not change the base UI's spawn-tool character capability.
  const childKey =
    typeof context.sessionKey === 'string' && /:(?:subagent|acp):/.test(context.sessionKey)
      ? context.sessionKey
      : undefined;
  return {
    ...context,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(agentId
      ? {
          actorId: opaqueId(`${namespace}:${agentId}${childKey ? `:${childKey}` : ''}`),
          displayName: childKey ? `${displayName} · subtask` : displayName,
        }
      : {}),
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
    ...(typeof context.actorId === 'string' ? { actor_id: context.actorId } : {}),
    ...(typeof context.displayName === 'string' ? { display_name: context.displayName } : {}),
    ...(typeof context.workspaceDir === 'string' ? { cwd: context.workspaceDir } : {}),
  });
  return id;
}

export default definePluginEntry({
  id: 'pixel-agents-openclaw',
  name: 'Pixel Agents OpenClaw Relay',
  description: 'Sends content-free lifecycle events to local or remote Pixel Agents servers.',
  register(api) {
    const sendEvent = eventSender(api);
    const activity = new SessionActivityAggregator(sendEvent);
    const postEvent = (event: Record<string, unknown>) => activity.accept(event);
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const cancelIdle = (id: string) => {
      const timer = idleTimers.get(id);
      if (timer) clearTimeout(timer);
      idleTimers.delete(id);
    };
    api.on('model_call_started', async (event, context) => {
      const id = sessionId(event, context);
      if (id) cancelIdle(id);
      await announceSession(postEvent, event, hookContext(api, context));
    });

    // Use metadata-only completion hooks. agent_end carries conversation data
    // and is deliberately not registered or granted conversation access.
    api.on('model_call_ended', async (event, context) => {
      const id = sessionId(event, context);
      if (!id) return;
      cancelIdle(id);
      const timer = setTimeout(() => {
        idleTimers.delete(id);
        void postEvent({ event: 'model_idle', session_id: id });
      }, 250);
      timer.unref?.();
      idleTimers.set(id, timer);
    });

    api.on('before_tool_call', async (event, context) => {
      const sid = sessionId(event, context);
      if (sid) cancelIdle(sid);
      const id = await announceSession(postEvent, event, hookContext(api, context));
      if (!id) return;
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
      cancelIdle(id);
      await postEvent({
        event: 'session_end',
        session_id: id,
        ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
      });
    });

    // Metadata-only child completion: remove the actual delegated character,
    // including background children whose spawn tool returned earlier.
    const closeChild = async (key: string) => {
      const id = opaqueId(key);
      cancelIdle(id);
      await postEvent({ event: 'session_end', session_id: id });
    };
    api.on('subagent_ended', async (event) => {
      if (typeof event.targetSessionKey === 'string') await closeChild(event.targetSessionKey);
    });
    api.on('subagent_progress', async (event) => {
      if (event.phase === 'ended' && typeof event.childSessionKey === 'string')
        await closeChild(event.childSessionKey);
    });

    api.on('gateway_stop', async () => {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      await activity.stop();
    });
  },
});
