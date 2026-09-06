/**
 * The server token this page was opened with -- the `?token=` in the URL the
 * CLI printed -- or null when the page was opened bare.
 *
 * It is the one thing that makes a standalone session privileged: approving a
 * hook install, launching an agent, attaching to its terminal. The server never
 * hands it out over HTTP (a same-origin endpoint would make Host/Origin the
 * gate, and both are attacker-supplied on a rebound or forwarded connection),
 * so the URL is the only way in and every consumer reads it from here. Read
 * once at load: the address bar may be cleaned up later, the token must not be.
 * See server/src/httpServer.ts (standaloneTokenValid).
 */
export const serverToken: string | null = readServerToken();

function readServerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('token');
  } catch {
    return null;
  }
}
