/**
 * How a script Claude Code spawns reaches Pixel Agents: every live server in
 * the registry (VS Code embedded + standalone, several of either), falling
 * back to the legacy single server.json. Shared by the hook script and the
 * status line bridge; bundled into each (dist/hooks/), never imported by the
 * server.
 *
 * Everything here is best-effort and silent: a script that cannot reach a
 * server must still exit cleanly, and one dead server must never block
 * delivery to the others.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR, SERVER_JSON_NAME, SERVERS_DIR } from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/** Diagnostic sink; a no-op unless the caller logs somewhere. */
export type ScriptDebug = (line: string) => void;

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
 * event can fan out to each running server. Entries whose owning PID is no
 * longer alive are skipped (the owning server prunes its own stale file on
 * next start; a script only needs to not POST to it). Returns an empty array
 * when the directory is absent/empty/unreadable.
 */
export function readRegistry(debug: ScriptDebug): ServerConfig[] {
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

/**
 * The servers to deliver to: every live registry entry, else the legacy
 * server.json (forward-compat with a server that predates the registry), else
 * none — `null`, logged as ONE exit line naming `label` (what was being
 * delivered) and why.
 */
export function liveServers(debug: ScriptDebug, label: string): ServerTarget[] | null {
  const servers: ServerTarget[] = readRegistry(debug);
  if (servers.length > 0) return servers;
  try {
    const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
    if (!isServerTarget(legacy)) {
      throw new Error('invalid legacy server config');
    }
    return [legacy];
  } catch (e) {
    debug(
      `exit reason=no-server-json ${label} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** One delivery: where it goes on the server, what it carries, how it is
 *  named in the debug log, and how long to wait. */
export interface ServerPost {
  path: string;
  body: string;
  label: string;
  debug: ScriptDebug;
  timeoutMs: number;
}

/**
 * POST a JSON body to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code. `label` names the delivery in the debug log.
 */
export function postToServer(server: ServerTarget, post: ServerPost): Promise<void> {
  const { path: urlPath, body, label, debug, timeoutMs } = post;
  debug(`POST ${label} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: urlPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: timeoutMs,
        },
        (res) => {
          debug(`POST-done ${label} status=${res.statusCode} port=${server.port}`);
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        debug(`POST-error ${label} port=${server.port} err=${err.message}`);
        resolve();
      });
      req.on('timeout', () => {
        debug(`POST-timeout ${label} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      debug(
        `POST-error ${label} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}
