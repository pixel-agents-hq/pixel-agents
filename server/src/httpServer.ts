import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { CapabilityRegistry } from './capabilities.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { KEY_BYPASS_PERMISSIONS } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  TASK_DISPATCH_FORBIDDEN_BODY,
  TASK_DISPATCH_MCP_MAX_REQUEST_BYTES,
  TASK_DISPATCH_MCP_PATH,
  TASK_DISPATCH_UNAUTHORIZED_BODY,
  WRITE_GUARD_API_PATH,
  WRITE_GUARD_BAD_REQUEST_BODY,
  WRITE_GUARD_FORBIDDEN_BODY,
  WRITE_GUARD_MAX_REQUEST_BYTES,
  WRITE_GUARD_UNAUTHORIZED_BODY,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import type { CuratorTable } from './curators.js';
import { createKbBrowseSlots } from './kbBrowse.js';
import type { TaskDispatchLaunch } from './taskDispatch/launchConfig.js';
import { handleMcpBody } from './taskDispatch/mcpEndpoint.js';
import { TaskDispatcher } from './taskDispatch/taskDispatcher.js';
import { OperatorInputTracker } from './terminal/operatorInput.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { AgentState } from './types.js';
import {
  guardRequestAuthorized,
  guardRequestForbidden,
  singleAuthorizationHeader,
} from './writeGuard/endpointFilter.js';
import type { GuardStatusReporter } from './writeGuard/guardStatusReporter.js';
import type { GuardVerdict } from './writeGuard/protocol.js';
import type { WriteGuard } from './writeGuard/writeGuard.js';
import { bearerTokenValid, isAllowedWebSocketOrigin } from './wsAuth.js';

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
  /** Per-agent capabilities and Workspace curators (standalone, in memory). */
  capabilities?: CapabilityRegistry;
  curators?: CuratorTable;
  /** 阻擋式裁決（standalone 限定）。內嵌模式即使傳入也一律忽略：
   *  端點對任何 session 回 unknown-session。 */
  writeGuard?: WriteGuard;
  /** agentGuardStatus 回報（standalone 限定）。 */
  guardStatus?: GuardStatusReporter;
  /**
   * Task dispatch (standalone only): the bundled stdio shim's path. THE switch
   * for the feature: present (with capabilities, curators, ptyManager and
   * guardStatus) the /mcp endpoint exists and launches into non-default
   * Workspaces carry the shim; absent, neither does. Ignored in embedded mode.
   */
  taskDispatchShimPath?: string;
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
    // Standalone logs every request; embedded stays quiet.
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  // 裁決端點的檢查是根層級的 onRequest，且在 CORS 之前加入，所以它先於
  // @fastify/cors 執行（沿用 S3b /mcp 的作法）。
  registerWriteGuardFilter(app, options.token);

  // Task dispatch: the same root-level, before-CORS filter for /mcp.
  const taskDispatch = createTaskDispatch(options);
  if (taskDispatch) registerTaskDispatchFilter(app, taskDispatch.capabilities);

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

  const host = options.host ?? '127.0.0.1';

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerWriteGuardRoute(app, options);
  // The launch side of task dispatch needs the port, known only after listen;
  // every launch happens over /ws after that, so the ref is always set by then.
  const taskDispatchLaunch: { current: TaskDispatchLaunch | undefined } = { current: undefined };
  registerWebSocketRoute(app, options, taskDispatchLaunch);
  registerTerminalRoutes(app, {
    ptyManager: options.ptyManager,
    operatorInput: taskDispatch?.operatorInput,
  });
  if (taskDispatch) {
    registerTaskDispatchRoute(app, taskDispatch.dispatcher);
    app.addHook('onClose', async () => taskDispatch.dispatcher.dispose());
  }

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;
  if (taskDispatch) taskDispatchLaunch.current = { port, shimPath: taskDispatch.shimPath };

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

// ── Write Guard ────────────────────────────────────────────────

const UNKNOWN_SESSION: GuardVerdict = { verdict: 'unknown-session' };

/**
 * 裁決端點的根層級 onRequest 檢查。以路由比對的結果（routeOptions.url）判斷，
 * 不用 request.url，所以 `/api/guard/%76erdict` 之類的寫法也會經過這裡。
 * 只看標頭：被拒絕的請求不會讀 body。先 403（網路層縱深防禦），再 401（Bearer）。
 */
function registerWriteGuardFilter(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url !== WRITE_GUARD_API_PATH) return;
    if (
      guardRequestForbidden({
        rawHeaders: request.raw.rawHeaders,
        remoteAddress: request.socket.remoteAddress,
      })
    ) {
      return reply.code(403).send(WRITE_GUARD_FORBIDDEN_BODY);
    }
    if (!guardRequestAuthorized(request.raw.rawHeaders, token)) {
      return reply.code(401).send(WRITE_GUARD_UNAUTHORIZED_BODY);
    }
  });
}

/**
 * POST 裁決端點。內嵌（VS Code）伺服器對任何 session 一律回 unknown-session
 * （分流：規則只對 standalone 生效）。standalone 的裁決只做記憶體查詢（F13）。
 */
function registerWriteGuardRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const guard = options.embedded ? undefined : options.writeGuard;
  app.post(
    WRITE_GUARD_API_PATH,
    { bodyLimit: WRITE_GUARD_MAX_REQUEST_BYTES },
    async (request, reply) => {
      if (!guard) return reply.send(UNKNOWN_SESSION);
      const verdict = guard.verdict(request.body);
      if (!verdict) return reply.code(400).send(WRITE_GUARD_BAD_REQUEST_BODY);
      return reply.send(verdict);
    },
  );
}

// ── Task dispatch (/mcp) ───────────────────────────────────────

interface TaskDispatchWiring {
  dispatcher: TaskDispatcher;
  capabilities: CapabilityRegistry;
  operatorInput: OperatorInputTracker;
  shimPath: string;
}

/** The dispatcher and its inputs, or undefined when the feature is off. */
function createTaskDispatch(options: HttpServerOptions): TaskDispatchWiring | undefined {
  if (options.embedded || options.taskDispatchShimPath === undefined) return undefined;
  const { capabilities, curators, ptyManager, guardStatus, store } = options;
  if (!capabilities || !curators || !ptyManager || !guardStatus) return undefined;
  const operatorInput = new OperatorInputTracker();
  store.on('agentRemoved', (id) => operatorInput.forget(id));
  const dispatcher = new TaskDispatcher({
    store,
    ptyManager,
    capabilities,
    curators,
    guard: guardStatus,
    operatorInput,
    // Read at every evaluation: turning the setting on stops dispatch at once.
    // No adapter means the setting cannot be read, which counts as on.
    hostBypassEnabled: () =>
      store.getAdapter()?.getSetting(KEY_BYPASS_PERMISSIONS, false) !== false,
  });
  return { dispatcher, capabilities, operatorInput, shimPath: options.taskDispatchShimPath };
}

/** Whether a request is for /mcp: the matched route, or (an OPTIONS preflight,
 *  which CORS's wildcard route matches) the literal path. */
function isTaskDispatchRequest(request: FastifyRequest): boolean {
  if (request.routeOptions.url === TASK_DISPATCH_MCP_PATH) return true;
  return request.url.split('?')[0] === TASK_DISPATCH_MCP_PATH;
}

/**
 * /mcp's root-level onRequest filter, added BEFORE CORS (origin: true) so it
 * runs first. Headers only, the body is never read: 403 for any Origin, any
 * forwarding header, anything but exactly one loopback Host from a loopback
 * peer (guardRequestForbidden, the write-guard semantics); then 401 unless
 * there is exactly one Authorization header holding a valid CAPABILITY. The
 * server token is never accepted here, and the /ws predicate is never used.
 */
function registerTaskDispatchFilter(app: FastifyInstance, capabilities: CapabilityRegistry): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isTaskDispatchRequest(request)) return;
    if (
      guardRequestForbidden({
        rawHeaders: request.raw.rawHeaders,
        remoteAddress: request.socket.remoteAddress,
      })
    ) {
      return reply.code(403).send(TASK_DISPATCH_FORBIDDEN_BODY);
    }
    const authorization = singleAuthorizationHeader(request.raw.rawHeaders);
    if (authorization === null || capabilities.verify(authorization) === null) {
      return reply.code(401).send(TASK_DISPATCH_UNAUTHORIZED_BODY);
    }
  });
}

function registerTaskDispatchRoute(app: FastifyInstance, dispatcher: TaskDispatcher): void {
  app.post(
    TASK_DISPATCH_MCP_PATH,
    { bodyLimit: TASK_DISPATCH_MCP_MAX_REQUEST_BYTES },
    async (request, reply) => {
      // The filter already required exactly one header.
      const authorization = singleAuthorizationHeader(request.raw.rawHeaders) ?? '';
      const answer = await handleMcpBody(request.body, authorization, {
        dispatch: (presented, args) => dispatcher.dispatch(presented, args),
        version: process.env.PIXEL_AGENTS_VERSION ?? '',
      });
      if (answer.body === undefined) return reply.code(answer.status).send();
      return reply.code(answer.status).type('application/json').send(answer.body);
    },
  );
  // Streamable-HTTP GET (server-sent events) and session DELETE are not offered.
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: TASK_DISPATCH_MCP_PATH,
    handler: async (_request, reply) => reply.code(405).header('allow', 'POST').send(),
  });
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  taskDispatchLaunch: { current: TaskDispatchLaunch | undefined },
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin); a
    // non-browser local client with no Origin still connects. Every accepted
    // connection has full control.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    const { store } = options;
    // KB browsing's in-flight cap is per connection (kbBrowse.ts).
    const kbBrowse = createKbBrowseSlots();

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        directoryName: agent.directoryName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        workspaceId: agent.workspaceId,
        roleName: agent.roleName,
        name: agent.displayName,
        stopped: agent.stopped || undefined,
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
          capabilities: options.capabilities,
          curators: options.curators,
          guardStatus: options.embedded ? undefined : options.guardStatus,
          taskDispatch: taskDispatchLaunch.current,
          kbBrowse,
        });
      } catch (error) {
        // Malformed JSON is dropped; a handler that threw is logged, because a
        // swallowed exception leaves the client waiting for a reply that never comes.
        console.error('[Pixel Agents] WS client message failed:', error);
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

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
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
