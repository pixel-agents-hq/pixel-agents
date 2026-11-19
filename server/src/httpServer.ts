import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { agentCreatedMessage } from './agentMessages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage, uploadDirectoryOf } from './clientMessageHandler.js';
import { readConfig } from './configPersistence.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  STATIC_FONT_MAX_AGE_SECONDS,
  STATIC_HASHED_MAX_AGE_SECONDS,
  USAGE_API_PREFIX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { applyReportedContext } from './contextUsage.js';
import type { OfficeMcpFeature } from './mcp/composeOfficeMcp.js';
import type { PcShellRegistry, PcShellView } from './pcShells.js';
import { hookProviderById } from './providers/index.js';
import { startUploadSweeps } from './terminal/fileUploads.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';
import {
  PRIVILEGED_BROADCAST_TYPES,
  recordUsageReport,
  usageLimitsMessage,
} from './usageLimits.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  privilegedHostnames,
  redactTokenQuery,
  standaloneHandshakeVerdict,
} from './wsAuth.js';

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
  ptyManager?: TerminalSessions;
  /** The PC shells: their list sent on connect, their ids kept in the card order (both surfaces). */
  pcShells?: PcShellView;
  /** The PC shells opened and closed over /ws (standalone only). */
  pcShellControl?: PcShellRegistry;
  /** The package root holding dist/hooks/ (standalone), from which the Usage
   *  Bars toggle installs the status line bridge script. */
  packageRoot?: string;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
  /** The Pixel Office MCP: mounted at /mcp when given (its own per-agent
   *  tokens, never this server's), and handed to the message handler for its
   *  messages, its part of the handshake and launches; each socket's
   *  editing-lock report is dropped when it closes. */
  officeMcp?: OfficeMcpFeature;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/** A Vite bundle: `assets/<name>-<8 hash characters>.js|css`. */
const HASHED_BUNDLE = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const FONT_FILE = /[\\/]fonts[\\/][^\\/]+\.woff2$/;

/** The `Cache-Control` of a static file the browser may keep, or null to
 *  leave it revalidated on every load. */
export function staticCacheControl(filePath: string): string | null {
  if (HASHED_BUNDLE.test(filePath)) {
    return `public, max-age=${STATIC_HASHED_MAX_AGE_SECONDS}, immutable`;
  }
  if (FONT_FILE.test(filePath)) return `public, max-age=${STATIC_FONT_MAX_AGE_SECONDS}`;
  return null;
}

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded ? false : { serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
      // Files that never change under their name are kept by the browser, so a
      // reopened office (a phone's home-screen app above all) doesn't fetch the
      // font and the bundle again: Vite's hashed bundles for good, the font for
      // STATIC_FONT_MAX_AGE_SECONDS. Everything else (index.html, the manifest,
      // furniture art) is revalidated on every load, as before.
      setHeaders: (res, filePath) => {
        const cacheControl = staticCacheControl(filePath);
        if (cacheControl) res.header('Cache-Control', cacheControl);
      },
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  const host = options.host ?? '127.0.0.1';
  const allowedHostnames = privilegedHostnames(host, options.allowedHosts ?? []);

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerUsageRoute(app, options);
  options.officeMcp?.registerRoutes(app);
  registerWebSocketRoute(app, options, allowedHostnames);
  registerTerminalRoutes(app, {
    token: options.token,
    allowedHostnames,
    ptyManager: options.ptyManager,
    uploadDirectory: () => uploadDirectoryOf(options.store.getAdapter()),
    sourceDirectories: () => readConfig().directories.map((directory) => directory.path),
  });
  if (options.ptyManager) {
    const stopUploadSweeps = startUploadSweeps();
    app.addHook('onClose', () => stopUploadSweeps());
  }

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host, port: options.port ?? 0 });
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

// ── Usage reports ──────────────────────────────────────────────

/** A provider's usage bridge reports the account's plan limits here. Stored,
 *  and passed on to the office when they moved (recordUsageReport). */
function registerUsageRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{ Params: { providerId: string }; Body: unknown }>(
    `${USAGE_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { providerId: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const provider = hookProviderById(request.params.providerId);
      if (provider && recordUsageReport(provider, request.body)) {
        options.store.broadcast({ ...usageLimitsMessage(provider.id) });
      }
      const context = provider?.usageBridge?.normalizeContext(request.body);
      if (context) applyReportedContext(options.store, context);
      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    let privileged = options.embedded;
    if (!options.embedded) {
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        allowedHostnames,
      );
      privileged = verdict === 'privileged';
      if (verdict === 'untrusted-host') {
        // The operator has the right URL but reached us under a name they never
        // listed (typically a reverse proxy). Say how to fix it, or the session
        // silently stays watch-only.
        console.warn(
          `[Pixel Agents] Tokened connection via Host "${request.headers.host ?? ''}" is read-only: restart with --allowed-host <that name> to allow changes from it.`,
        );
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, agentCreatedMessage(id, agent));
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      // The operator's account usage is not for read-only viewers.
      if (!privileged && PRIVILEGED_BROADCAST_TYPES.has(String(message.type))) return;
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
          packageRoot: options.packageRoot,
          privileged,
          ptyManager: options.ptyManager,
          pcShells: options.pcShells,
          pcShellControl: options.pcShellControl,
          officeMcp: options.officeMcp,
          client: socket,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
      // A closed office no longer holds unsaved layout changes.
      options.officeMcp?.clientGone(socket);
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

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactTokenQuery(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
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
