import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { HOOK_API_PREFIX, MAX_HOOK_BODY_SIZE } from './constants.js';
import type { AgentState } from './types.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  // Standalone mode skips Bearer auth on /ws (below), so the Origin guard is
  // what keeps the socket local. Registered as a route-level preValidation --
  // @fastify/websocket runs the normal request lifecycle before upgrading, so
  // replying here aborts the handshake with a plain HTTP response instead of
  // a 101. Embedded (VS Code) mode is untouched: its transport is postMessage.
  const routeOptions = options.embedded
    ? { websocket: true as const }
    : { websocket: true as const, preValidation: websocketOriginGuard(app) };

  app.get('/ws', routeOptions, (socket, request) => {
    // In standalone mode (not embedded), skip Bearer auth for WebSocket
    // connections: the SPA is served from this same origin and has no token to
    // present. Loopback binding alone does NOT make that safe (WebSocket
    // handshakes ignore the same-origin policy), which is what the
    // preValidation Origin guard above covers.
    // In embedded mode (VS Code), require Bearer token for security.
    if (options.embedded) {
      const auth = request.headers.authorization ?? '';
      const expected = `Bearer ${options.token}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── WebSocket Origin Guard ─────────────────────────────────────

/** Hostnames the SPA can legitimately be served from by a loopback-bound server. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True when `origin` is the very origin this server serves the SPA from.
 *
 * Binding to 127.0.0.1 is NOT sufficient protection for /ws: WebSocket
 * handshakes are exempt from the browser's same-origin policy, so any page a
 * user has open can open `ws://127.0.0.1:<port>/ws` and — absent this check —
 * speak the full ClientMessage protocol to the local server. The port must
 * match too: another loopback service on a different port is a different
 * origin and equally untrusted.
 */
function isAllowedWebSocketOrigin(origin: string, hostHeader: string | undefined, port: number) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // Opaque origins ("null") and malformed values are never allowed.
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // Same origin as the URL this very request was addressed to. This is the
  // general case and covers any bind host (`--host 0.0.0.0` reached over a LAN
  // address included): a browser derives Host from the connection URL and
  // Origin from the page URL, and the SPA builds its ws:// URL from
  // window.location, so for a legitimately-served page the two always agree.
  // A hijacked tab is exactly the case where they don't.
  if (hostHeader !== undefined && url.host === hostHeader) return true;

  // Fallback for the default loopback deployment, where 127.0.0.1 and
  // localhost are interchangeable names for the same served origin.
  return LOOPBACK_HOSTNAMES.has(url.hostname) && url.port === String(port);
}

/**
 * preValidation guard for /ws in standalone mode.
 *
 * A request with NO Origin header is allowed through: browsers always send one
 * on a WebSocket handshake, so its absence is itself evidence that the caller
 * is not a hijacked browser tab (CLI clients, test harnesses, and other
 * non-browser consumers of the protocol keep working).
 */
function websocketOriginGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin === undefined) return;

    // Read the bound port lazily: with port 0 it isn't known until listen(),
    // which happens after the route is registered.
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    if (!isAllowedWebSocketOrigin(origin, request.headers.host, port)) {
      await reply.code(403).send('forbidden origin');
    }
  };
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${expectedToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
