import { MAX_PORT, MIN_PORT, SERVER_REGISTRY_PROTOCOL_VERSION } from './constants.js';

/** Minimum fields the hook producer needs to contact a server. Kept separate
 *  from ServerConfig so the new hook script can still reach an old server via
 *  the legacy server.json record during the mixed-version compatibility window. */
export interface ServerTarget {
  port: number;
  pid: number;
  token: string;
  debugLog?: string;
}

/** Complete per-server discovery record stored in the multi-server registry. */
export interface ServerConfig extends ServerTarget {
  /** Timestamp (ms) when the server started. */
  startedAt: number;
  /** Whether this server serves the webview SPA (standalone / !embedded). */
  servesSpa: boolean;
  /** Registry record format version. */
  protocol: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the contact fields shared by current and legacy discovery records. */
export function isServerTarget(value: unknown): value is ServerTarget {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.port) &&
    (value.port as number) >= MIN_PORT &&
    (value.port as number) <= MAX_PORT &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    (value.debugLog === undefined || typeof value.debugLog === 'string')
  );
}

/** Validate a complete current-version registry record before reuse/fan-out. */
export function isServerConfig(value: unknown): value is ServerConfig {
  if (!isServerTarget(value) || !isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.startedAt) &&
    (value.startedAt as number) >= 0 &&
    typeof value.servesSpa === 'boolean' &&
    value.protocol === SERVER_REGISTRY_PROTOCOL_VERSION
  );
}
