/**
 * WebSocket URL for a server endpoint, resolved against the page's base URL
 * rather than the host root, so the SPA keeps working when a reverse proxy
 * mounts it at a sub-path (`https://host/pa/` → `wss://host/pa/ws`). At the
 * root it is unchanged (`/` → `/ws`). `path` is relative to the SPA's mount
 * point; a leading slash is ignored so callers can pass route prefixes as-is.
 */
export function socketUrl(path: string, baseUri: string, token: string | null): string {
  const url = new URL(path.replace(/^\/+/, ''), baseUri);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.hash = '';
  url.search = token ? `?token=${encodeURIComponent(token)}` : '';
  return url.toString();
}
