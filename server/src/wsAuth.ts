/**
 * The server's token, Host and origin predicates -- ONE implementation for
 * every gate: the hook endpoint's Bearer header, the embedded `/ws` Bearer
 * header, and the standalone same-origin check on `/ws` and
 * `/terminal/:agentId`.
 *
 * Pure functions over plain values so the security-relevant decisions (is this
 * token valid? is this origin ours?) are unit-testable without a live socket,
 * and so a second socket can never grow a second, subtly different copy.
 */

import * as crypto from 'crypto';

import { LOOPBACK_HOSTNAMES } from './constants.js';

/** Constant-time string compare, length-guarded (timingSafeEqual throws on a
 *  length mismatch; the length itself is not secret). */
export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/** `Authorization: Bearer <token>` check for HTTP routes and the embedded `/ws`. */
export function bearerTokenValid(authorization: string | undefined, expected: string): boolean {
  return timingSafeStringEqual(authorization ?? '', `Bearer ${expected}`);
}

/**
 * Standalone CONNECTION gate: is this handshake same-origin?
 *
 * WebSocket connects are NOT subject to CORS, so without this any web page the
 * user happens to visit could open a socket to 127.0.0.1 and start talking.
 * Comparing Origin's host against the request's own Host header makes the check
 * same-origin by construction — it tracks whatever --host/--port the server was
 * bound to with zero configuration, and treats `localhost` and `127.0.0.1`
 * correctly (a browser derives both headers from the URL that loaded the SPA).
 *
 * A missing Origin still connects: non-browser local clients send none (and can
 * already read ~/.pixel-agents/server.json off disk).
 *
 * Both header values are client-supplied, so a DNS-rebound page (`evil.com` →
 * 127.0.0.1) sends `Origin: http://evil.com:PORT` AND `Host: evil.com:PORT` and
 * passes equality. Every accepted standalone connection has full control.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // An unparseable Origin is not a same-origin browser request.
    return false;
  }
}

// ── Host names ─────────────────────────────────────────────────

const HOST_CHARS = /^[A-Za-z0-9.\-:[\]]+$/;

/**
 * Lower-cased hostname of a Host header or a bare host argument, with the port
 * and IPv6 brackets stripped (`[::1]:3100` -> `::1`, `Example.ts.net` ->
 * `example.ts.net`), or null when it is empty or unparseable.
 */
export function normalizeHostname(host: string | undefined): string | null {
  // Host-shaped characters only: URL parsing would otherwise read
  // `evil@127.0.0.1` or `127.0.0.1/x` as the hostname 127.0.0.1.
  if (!host || !HOST_CHARS.test(host)) return null;
  // A bare IPv6 literal (`::1`, a --host value) has no
  // brackets; URL parsing needs them.
  const bracketed = !host.startsWith('[') && host.split(':').length > 2 ? `[${host}]` : host;
  try {
    const { hostname } = new URL(`http://${bracketed}`);
    const bare =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return bare === '' ? null : bare;
  } catch {
    return null;
  }
}

/** True when a bind host or Host header names this machine's loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = normalizeHostname(host);
  return name !== null && (LOOPBACK_HOSTNAMES as readonly string[]).includes(name);
}
