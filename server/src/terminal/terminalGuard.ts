/**
 * The terminal socket's defence-in-depth guard: same-origin plus, when the
 * server is bound to loopback, a loopback `Host` header.
 *
 * This is NEVER the gate. The gate is the server token (wsAuth.ts,
 * standaloneTokenValid), the same secret that privileges `/ws`. This guard sits
 * on top of it because `/terminal/:agentId` is a shell: it cheaply blunts DNS
 * rebinding, the one shape where Origin === Host holds for an attacker page.
 */

import { LOOPBACK_HOSTNAMES } from '../constants.js';
import { isAllowedWebSocketOrigin } from '../wsAuth.js';

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
 * Same-origin AND (when the server is bound to loopback) a loopback Host header.
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
  if (!isAllowedWebSocketOrigin(origin, host)) return false;
  if (enforceLoopbackHost && !isLoopbackHostHeader(host)) return false;
  return true;
}
