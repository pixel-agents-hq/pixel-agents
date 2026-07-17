/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Terminal (standalone embedded terminal) ──────────────────
// The raw PTY byte stream deliberately lives OUTSIDE the AsyncAPI contract --
// it is a data plane (unstructured, high-frequency), not a control plane.
// Only the terminal's control-plane facts (availability, session open/close)
// are AsyncAPI ServerMessages. See docs/design/standalone-terminal.md.

/** Path prefix for the per-agent terminal WebSocket: `/terminal/:agentId`. */
export const TERMINAL_WS_PREFIX = '/terminal';
/** Same-origin-guarded endpoint that hands the SPA the auth token it needs to
 *  open a terminal socket (a browser cannot read ~/.pixel-agents/server.json). */
export const TERMINAL_SESSION_API_PATH = '/api/terminal/session';
/** WebSocket subprotocol identifying a terminal connection. The auth token
 *  rides as the SECOND subprotocol value, because the browser WebSocket API
 *  cannot set an Authorization header and standalone runs Fastify with
 *  `logger: true` -- a `?token=` query param would be written to the request
 *  log on every connection. */
export const TERMINAL_WS_PROTOCOL = 'pixel-agents.terminal.v1';

/** Close codes for the terminal socket (4000-4999 = application-defined). */
export const TERMINAL_CLOSE_UNAUTHORIZED = 4401;
export const TERMINAL_CLOSE_NO_SESSION = 4404;

/** Loopback hostnames. Used both to warn when the server binds off-loopback and
 *  as the anti-DNS-rebinding allowlist for the terminal's Host header: a rebound
 *  page reaches 127.0.0.1 but its Host header is still the attacker's domain, so
 *  a loopback-bound server can safely refuse any non-loopback Host. */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'] as const;

// ── Control plane (/ws) auth ─────────────────────────────────
// The /ws WebSocket carries the AsyncAPI control plane, and in standalone it can
// spawn agents (launchAgent). It is authenticated with the same bearer token as
// the hook endpoint. Non-browser clients (VS Code host, MCP bridge, curl) send
// `Authorization: Bearer <token>`; the browser SPA cannot set that header, so it
// rides the token as the SECOND subprotocol value, exactly like the terminal
// socket — with the same `?token=` request-log leak avoided.

/** WebSocket subprotocol identifying an authenticated control-plane (/ws)
 *  connection. The auth token rides as the SECOND subprotocol value. */
export const CONTROL_WS_PROTOCOL = 'pixel-agents.control.v1';
/** Same-origin-guarded endpoint that hands the SPA the token it needs to open
 *  the /ws socket (a browser cannot read ~/.pixel-agents/server.json, and the
 *  WebSocket constructor cannot set an Authorization header). */
export const CONTROL_SESSION_API_PATH = '/api/session';
/** Close code for an unauthorized /ws connection (4000-4999 = app-defined). */
export const CONTROL_CLOSE_UNAUTHORIZED = 4401;

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';
