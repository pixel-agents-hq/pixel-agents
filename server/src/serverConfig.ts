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

/**
 * What a standalone server exposes, as the operator asked for it at launch.
 * Recorded so a second `npx pixel-agents` reuses a running server only when it
 * would have started the SAME one -- otherwise `--no-terminal` or a narrower
 * `--host` would be silently ignored in favour of a server that has a shell.
 */
export interface StandaloneAccess {
  /** Whether the browser may launch agents and attach to their terminals. */
  terminal: boolean;
  /** Bind address. */
  host: string;
  /** Normalized, sorted `--allowed-host` names. */
  allowedHosts: string[];
}

/** Complete per-server discovery record stored in the multi-server registry. */
export interface ServerConfig extends ServerTarget {
  /** Timestamp (ms) when the server started. */
  startedAt: number;
  /** Whether this server serves the webview SPA (standalone / !embedded). */
  servesSpa: boolean;
  /** Registry record format version. */
  protocol: number;
  /** Standalone servers only. Absent on an entry written before this field
   *  existed, which then never matches a standalone request (start fresh). */
  standalone?: StandaloneAccess;
}

/** Whether a running server's access matches what this launch asked for.
 *  Embedded servers carry none and match each other. */
export function sameStandaloneAccess(
  running: StandaloneAccess | undefined,
  wanted: StandaloneAccess | undefined,
): boolean {
  if (running === undefined || wanted === undefined) return running === wanted;
  return (
    running.terminal === wanted.terminal &&
    running.host === wanted.host &&
    running.allowedHosts.length === wanted.allowedHosts.length &&
    running.allowedHosts.every((h, i) => h === wanted.allowedHosts[i])
  );
}

function isStandaloneAccess(value: unknown): value is StandaloneAccess {
  return (
    isRecord(value) &&
    typeof value.terminal === 'boolean' &&
    typeof value.host === 'string' &&
    Array.isArray(value.allowedHosts) &&
    value.allowedHosts.every((h) => typeof h === 'string')
  );
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
    value.protocol === SERVER_REGISTRY_PROTOCOL_VERSION &&
    (value.standalone === undefined || isStandaloneAccess(value.standalone))
  );
}
