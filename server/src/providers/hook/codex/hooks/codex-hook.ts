/**
 * Codex hook script. Codex spawns this once per lifecycle event with the event
 * payload on stdin; we forward it to every live Pixel Agents server and exit.
 *
 * Contract, identical to the Claude script's and for the same reasons:
 *  - Never block, veto, or rewrite anything. Codex's PreToolUse CAN deny a tool
 *    call, and PermissionRequest CAN pre-approve one — we deliberately use
 *    neither. This script emits no decision, so Codex's own behaviour is
 *    unchanged whether or not the office is running.
 *  - Never fail loudly. Every error path (no server, bad stdin, refused
 *    connection, timeout, non-2xx) resolves quietly and the process exits 0, so
 *    a stopped office can never wedge the agent loop.
 *  - Never be slow. 2s per-request timeout, requests fan out in parallel.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  HOOK_API_PREFIX,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVERS_DIR,
} from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';
import { CODEX_PROVIDER_ID } from '../constants.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/** Diagnostic log, mirroring the Claude script: hook delivery is otherwise
 *  100% silent, so a dropped event is invisible in CI. Zero cost when unset. */
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} CODEXHOOK ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

/** True if a process with this PID is alive. Best-effort: a false positive on
 *  PID reuse costs one harmless failed POST, never a crash. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every live server under ~/.pixel-agents/servers/, so one event reaches a
 *  VS Code-embedded server and a standalone `npx pixel-agents` at once. Empty
 *  when absent/unreadable; the caller then falls back to legacy server.json. */
function readRegistry(): ServerConfig[] {
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
        hookDebug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        hookDebug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      hookDebug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/** POST one event to one server. Every failure path resolves quietly: a drop to
 *  one server must not affect any other, nor this script's exit code. */
function postToServer(
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<void> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/${CODEX_PROVIDER_ID}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve();
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input) as Record<string, unknown>;
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data['hook_event_name'] as string | undefined) ?? '?';
  const sid = (data['session_id'] as string | undefined)?.slice(0, 8) ?? '?';

  let servers: ServerTarget[] = readRegistry();
  if (servers.length === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
      if (!isServerTarget(legacy)) {
        throw new Error('invalid legacy server config');
      }
      servers = [legacy];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(0);
    }
  }

  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => (s as ServerConfig).debugLog);
    const p = (withDebugLog as ServerConfig | undefined)?.debugLog;
    if (p) debugLogPath = p;
  }

  const body = JSON.stringify(data);
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
