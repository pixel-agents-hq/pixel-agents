import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import {
  CONTROL_CLOSE_UNAUTHORIZED,
  CONTROL_SESSION_API_PATH,
  CONTROL_WS_PROTOCOL,
  TERMINAL_WS_PROTOCOL,
} from '../../core/src/constants.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { HOOK_API_PREFIX, MAX_HOOK_BODY_SIZE } from './constants.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import {
  extractTokenFromProtocolHeader,
  isLoopbackHost,
  isTrustedTerminalRequest,
  isValidToken,
} from './terminal/terminalProtocol.js';
import { registerTerminalRoutes } from './terminalRoutes.js';
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
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: PtySessionManager;
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
  await app.register(fastifyWebsocket, {
    options: {
      // The terminal and control sockets each carry their auth token as the
      // second subprotocol value (see terminal/terminalProtocol.ts). A browser
      // fails the connection unless the server echoes back one of the offered
      // protocols, so select the protocol NAME -- never the token, which must
      // not be reflected. A non-browser /ws client (Bearer header, no
      // subprotocol) offers none and is left exactly as it was.
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has(TERMINAL_WS_PROTOCOL)) return TERMINAL_WS_PROTOCOL;
        if (protocols.has(CONTROL_WS_PROTOCOL)) return CONTROL_WS_PROTOCOL;
        return false;
      },
    },
  });

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
  if (!options.embedded) {
    registerControlSessionRoute(app, options);
  }
  registerWebSocketRoute(app, options);
  registerTerminalRoutes(app, {
    token: options.token,
    host: options.host ?? '127.0.0.1',
    ptyManager: options.ptyManager,
  });

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

// ── Control session (standalone token handoff) ─────────────────

/**
 * Hands the SPA the token it needs to open the /ws control socket.
 *
 * Same rationale as the terminal session route: the browser can't read
 * ~/.pixel-agents/server.json, and the WebSocket constructor can't set an
 * Authorization header, so the token has to reach the page over HTTP first. The
 * trusted-origin guard (same-origin AND, on a loopback bind, a loopback Host) is
 * what stops any other site from fetching it -- cors({origin:true}) reflects
 * every Origin, and a DNS-rebound page defeats same-origin alone, so the Host
 * allowlist is the load-bearing clause. Registered standalone-only: embedded
 * clients hold the token in-process and never fetch it.
 */
function registerControlSessionRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const enforceLoopbackHost = isLoopbackHost(options.host ?? '127.0.0.1');
  app.get(
    CONTROL_SESSION_API_PATH,
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (
          !isTrustedTerminalRequest(
            request.headers.origin,
            request.headers.host,
            enforceLoopbackHost,
          )
        ) {
          await reply.code(403).send('forbidden');
        }
      },
    },
    async () => ({ token: options.token }),
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  // Enforce the anti-rebinding loopback-Host allowlist only when actually
  // loopback-bound; an operator who bound off-loopback opted into exposure and
  // their legitimate Host is a LAN name we can't enumerate (mirrors the terminal
  // route). Defence in depth: /ws requires the token regardless.
  const enforceLoopbackHost = isLoopbackHost(options.host ?? '127.0.0.1');

  app.get('/ws', { websocket: true }, (socket, request) => {
    // Authenticate BOTH modes. /ws can spawn agents (launchAgent) in standalone,
    // so binding to 127.0.0.1 is not a sufficient boundary: any page the user
    // visits can open ws://127.0.0.1/ws (WebSocket connections bypass CORS).
    // Non-browser clients (VS Code host, MCP bridge, curl) present the token as
    // `Authorization: Bearer <token>`; the browser SPA, which can't set that
    // header, rides it as the second subprotocol value.
    const provided =
      extractBearerToken(request.headers.authorization) ??
      extractTokenFromProtocolHeader(
        request.headers['sec-websocket-protocol'],
        CONTROL_WS_PROTOCOL,
      );
    if (!isValidToken(provided, options.token)) {
      socket.close(CONTROL_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    // Same-origin + loopback-Host guard, as on the terminal socket. Harmless to
    // Bearer/Node clients (no Origin, loopback Host) and blunts DNS rebinding.
    if (
      !isTrustedTerminalRequest(request.headers.origin, request.headers.host, enforceLoopbackHost)
    ) {
      socket.close(CONTROL_CLOSE_UNAUTHORIZED, 'forbidden origin');
      return;
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
          ptyManager: options.ptyManager,
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

// ── Auth Helper ────────────────────────────────────────────────

/** Pull the raw token out of an `Authorization: Bearer <token>` header, or null
 *  if absent/malformed. Comparison is deferred to isValidToken (constant-time). */
function extractBearerToken(auth: string | undefined): string | null {
  const prefix = 'Bearer ';
  if (auth === undefined || !auth.startsWith(prefix)) return null;
  return auth.slice(prefix.length);
}

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isValidToken(extractBearerToken(request.headers.authorization), expectedToken)) {
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
