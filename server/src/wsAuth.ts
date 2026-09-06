/**
 * The server's token and origin predicates -- ONE implementation for every
 * gate: the hook endpoint's Bearer header, the embedded `/ws` Bearer header,
 * the standalone `/ws` and `/terminal/:agentId` `?token=` query, and the
 * standalone same-origin connection check.
 *
 * Pure functions over plain values so the security-relevant decisions (is this
 * token valid? is this origin ours?) are unit-testable without a live socket,
 * and so a second socket can never grow a second, subtly different copy.
 */

import * as crypto from 'crypto';

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
 * Whether a standalone handshake proves PRIVILEGE -- the right to send messages
 * that reach outside `~/.pixel-agents/` (the hooks toggle, which grants durable
 * consent to modify `~/.claude/settings.json`), to launch an agent, or to attach
 * to its terminal (a shell running as the operator).
 *
 * The handshake must carry the server token in its `?token=` query. That token
 * is minted at startup (server.ts), printed by the CLI inside the LOCAL url it
 * emits to the operator's terminal, and forwarded by the SPA loaded from that
 * url (webview-ui/src/transport/serverToken.ts). It is the Jupyter model.
 *
 * Why a secret rather than a network position: EVERY position is reproducible.
 * The predecessor of this function required a loopback peer address AND a
 * loopback `Host`, on the theory that only a real local browser satisfies both.
 * A dumb TCP forwarder bound to the LAN, piping bytes verbatim to 127.0.0.1,
 * presents the server exactly what the SPA presents — `remoteAddress` is
 * 127.0.0.1 because the forwarder terminated the hop there, and `Host` is
 * whatever the remote client typed. Reproduced against the real `dist/cli.js`:
 * a client on another machine acquired consent and a 12-event install. Peer
 * address and Host/Origin are all carried BY the channel a proxy speaks, so the
 * gate must ride something the channel never carries — an out-of-band secret
 * the operator's own URL delivers and the forwarded attacker never sees.
 *
 * A tokenless client is not locked out of Pixel Agents — it connects and
 * watches the office exactly as before (the connection gate,
 * isAllowedWebSocketOrigin, is separate and unchanged). It simply cannot act
 * on this machine.
 *
 * The query is never written to the request log: httpServer's logger redacts
 * it (redactTokenQuery), so carrying the token here costs nothing on disk.
 */
export function standaloneTokenValid(url: string | undefined, expected: string): boolean {
  // Defensive: an empty configured token would otherwise privilege every
  // handshake that omits the query (both sides compare equal as '').
  if (!expected) return false;
  let provided: string;
  try {
    // Parsed against a dummy base because `request.url` is path-relative. Read
    // from the raw url rather than a framework-parsed query so the gate does
    // not depend on @fastify/websocket populating one on the upgrade request.
    provided = new URL(url ?? '', 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return false;
  }
  return timingSafeStringEqual(provided, expected);
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
 * already read ~/.pixel-agents/server.json off disk), and the standalone
 * server's read surface is deliberately open to whatever address it was told
 * to bind (`--host 0.0.0.0` exposes the SPA to the LAN by design).
 *
 * This gate is NOT sufficient for privileged actions and never was. Both header
 * values are attacker-supplied, so a DNS-rebound page (`evil.com` → 127.0.0.1)
 * sends `Origin: http://evil.com:PORT` AND `Host: evil.com:PORT` and passes
 * equality. See standaloneTokenValid for what actually guards privilege, and
 * terminal/terminalGuard.ts for the loopback-Host clause that blunts rebinding
 * on the terminal socket.
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

const TOKEN_QUERY_REDACTED = '[redacted]';

/**
 * Strip the token value from a request url before it is logged. The standalone
 * server logs every request (`logger: !embedded`), and `/ws?token=` and
 * `/terminal/:id?token=` would otherwise write the privilege secret to stdout
 * and any log file on every (re)connect. Pure string work on the raw url --
 * anything URL-parsing might normalise (encoding, ordering) is left alone so
 * the logged line still identifies the request.
 */
export function redactTokenQuery(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/g, `$1${TOKEN_QUERY_REDACTED}`);
}
