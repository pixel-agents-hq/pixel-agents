/**
 * The server token this page was opened with -- the `?token=` in the URL the
 * CLI printed -- or null when the page was opened bare.
 *
 * It is the one thing that makes a standalone session privileged: approving a
 * hook install, launching an agent, attaching to its terminal. The server never
 * hands it out over HTTP (a same-origin endpoint would make Host/Origin the
 * gate, and both are attacker-supplied on a rebound or forwarded connection),
 * so the URL is the only way in and every consumer reads it from here.
 *
 * The token deliberately STAYS in the address bar: the server persists it so a
 * bookmarked or home-screen URL keeps working across restarts, and stripping it
 * would break exactly that. The cost is that it sits in history -- the URL is a
 * secret, and `pixel-agents --rotate-token` is how a leaked one is revoked.
 * index.html sets `referrer: no-referrer` so it never leaves as a Referer.
 * See server/src/wsAuth.ts (standaloneTokenValid).
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
