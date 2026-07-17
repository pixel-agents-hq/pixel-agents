/**
 * Terminal data-plane framing + auth. Deliberately outside the AsyncAPI
 * contract: this is a raw byte stream, not control-plane state.
 * See docs/design/standalone-terminal.md ("Transport: why raw I/O is outside
 * AsyncAPI").
 *
 * Everything here is a pure function over plain values so the security-relevant
 * decisions (is this token valid? is this origin ours?) are unit-testable
 * without a live socket.
 */

import * as crypto from 'crypto';

import { LOOPBACK_HOSTNAMES, TERMINAL_WS_PROTOCOL } from '../../../core/src/constants.js';

// ── Frames ──────────────────────────────────────────────────────

/** server → client */
export type TerminalServerFrame =
  /** First frame on every attach: a serialized snapshot of the mirrored screen,
   *  plus the PTY geometry it was laid out at. The client resets, resizes to
   *  cols×rows, and writes `data` to reproduce the screen exactly. */
  | { type: 'replay'; data: string; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number };

/** client → server */
export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export function encodeServerFrame(frame: TerminalServerFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a client frame. Returns null for anything malformed or unrecognized --
 * this input is attacker-reachable (it's a WebSocket), so it is validated
 * structurally and never trusted to be well-formed.
 */
export function parseClientFrame(raw: string): TerminalClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type === 'input') {
    return typeof frame.data === 'string' ? { type: 'input', data: frame.data } : null;
  }
  if (frame.type === 'resize') {
    const { cols, rows } = frame;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return null;
    return { type: 'resize', cols, rows };
  }
  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ── Auth ────────────────────────────────────────────────────────

/**
 * Extract the auth token from a Sec-WebSocket-Protocol header.
 *
 * The client connects as `new WebSocket(url, [protocol, token])`, so the header
 * is `"<protocol>, <token>"`. The token rides here rather than in the URL
 * because standalone runs Fastify with `logger: true`, which writes req.url to
 * the log on every request -- a `?token=` param would leak the token into
 * stdout and log files. The browser WebSocket API cannot set an Authorization
 * header, so this is the only header available.
 *
 * Generic over the protocol name so both the terminal socket (TERMINAL_WS_
 * PROTOCOL) and the control socket (CONTROL_WS_PROTOCOL) share this parser; it
 * defaults to the terminal protocol for that socket's existing callers.
 */
export function extractTokenFromProtocolHeader(
  header: string | string[] | undefined,
  expectedProtocol: string = TERMINAL_WS_PROTOCOL,
): string | null {
  if (header === undefined) return null;
  const values = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (values[0] !== expectedProtocol) return null;
  return values[1] ?? null;
}

/** Constant-time token comparison, mirroring httpServer's bearerAuth. */
export function isValidToken(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; the length itself is not secret.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Same-origin guard.
 *
 * Required because @fastify/cors is registered with `origin: true`, which
 * reflects ANY Origin into Access-Control-Allow-Origin -- without this check a
 * page on any site could fetch the terminal token cross-origin and then open a
 * shell (WebSocket connections are exempt from CORS entirely).
 *
 * Absent Origin is allowed: browsers omit it on same-origin GET and always send
 * it cross-origin, so "absent" means a non-browser caller (curl, a local
 * script) -- which can already read ~/.pixel-agents/server.json off disk, so
 * rejecting it would protect nothing while breaking legitimate local tooling.
 *
 * NOTE: this alone does NOT stop DNS rebinding. A rebound page sends BOTH
 * Origin: http://evil.com AND Host: evil.com (the Host header is the URL's
 * hostname, which the browser controls), so origin.host === host holds and this
 * returns true. The Host-header allowlist in isTrustedTerminalRequest() is what
 * actually blunts rebinding -- see there.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // Unparseable Origin -- not something a real browser sends. Refuse.
    return false;
  }
}

const LOOPBACK_HOSTNAME_SET = new Set<string>(LOOPBACK_HOSTNAMES);

/** Strip the brackets URL parsing leaves on an IPv6 hostname (`[::1]` -> `::1`). */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** True when a raw host string (a bind arg, or an already-extracted hostname) is
 *  loopback. Used both to decide whether to enforce the rebinding guard and by
 *  the CLI's off-loopback warning. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTNAME_SET.has(unbracket(host).toLowerCase());
}

/** True when a Host *header* (which carries an optional port, e.g.
 *  `127.0.0.1:3100` or `[::1]:3100`) names a loopback host. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (host === undefined || host === '') return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

/**
 * The full terminal request guard: same-origin AND (when the server is bound to
 * loopback) a loopback Host header.
 *
 * The second clause is the DNS-rebinding defence. Rebinding only targets
 * loopback-bound services (the attacker rebinds their domain to 127.0.0.1 to
 * escape the same-origin policy), and a rebound request always carries the
 * attacker's domain as its Host header -- never a loopback literal, which the
 * browser derives from the URL. So a loopback-bound server can refuse any Host
 * it doesn't recognise. When the operator has deliberately bound off-loopback
 * (an opt-in, warned exposure), the Host is some legitimate LAN name we can't
 * enumerate, so this clause is skipped and the auth token is the guard.
 */
export function isTrustedTerminalRequest(
  origin: string | undefined,
  host: string | undefined,
  enforceLoopbackHost: boolean,
): boolean {
  if (!isSameOrigin(origin, host)) return false;
  if (enforceLoopbackHost && !isLoopbackHostHeader(host)) return false;
  return true;
}
