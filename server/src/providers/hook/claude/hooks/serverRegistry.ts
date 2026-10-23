/**
 * Server discovery for the scripts Claude Code runs (the hook script and the
 * status line script): every live Pixel Agents server, read from the
 * multi-server registry under ~/.pixel-agents/servers/, with the legacy single
 * server.json as the fallback. Bundled into each script; never throws.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR, SERVER_JSON_NAME, SERVERS_DIR } from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/** Diagnostics sink (the hook script's PIXEL_AGENTS_DEBUG_LOG writer). */
export type RegistryDebug = (line: string) => void;

/** True if a process with this PID is alive. Best-effort: a false positive on
 *  PID reuse just costs one extra, harmless, failed POST -- never a crash. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every live registry entry under ~/.pixel-agents/servers/, so the
 * event can fan out to each running server (VS Code embedded + a standalone
 * `npx pixel-agents`, or several of either, all at once). Entries whose owning
 * PID is no longer alive are skipped (the owning server prunes its own stale
 * file on next start; a script only needs to not POST to it). Returns an
 * empty array when the directory is absent/empty/unreadable -- the caller
 * falls back to the legacy single-target server.json (forward-compat with a
 * server that predates the registry).
 */
export function readRegistry(debug: RegistryDebug = () => {}): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const live: ServerConfig[] = [];
  for (const file of files) {
    const filePath = path.join(SERVERS_REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isServerConfig(entry)) {
        debug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        debug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      debug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/** The legacy single-target ~/.pixel-agents/server.json. Throws when it is
 *  missing or malformed (the caller logs why and gives up). */
export function readLegacyServer(): ServerTarget {
  const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
  if (!isServerTarget(legacy)) {
    throw new Error('invalid legacy server config');
  }
  return legacy;
}

/** Path of the legacy server.json, for diagnostics. */
export const LEGACY_SERVER_JSON_PATH = SERVER_JSON;
