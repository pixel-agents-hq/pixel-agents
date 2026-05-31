import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../../../constants.js';
import type { ServerConfig } from '../../../../server.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read server.json -> POST -> server) is otherwise 100%
 * silent: every failure path resolves quietly, so a dropped hook is invisible
 * in CI. Logging here lets a failing run show exactly where delivery dies
 * (bad-stdin, no-server-json, POST error/timeout, or HTTP status). Zero cost
 * when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading server.json we fall back to its
// `debugLog` field, which the server populated from the same env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  let server: ServerConfig;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8'));
  } catch (e) {
    hookDebug(
      `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(0);
  }

  // Adopt the server-provided debug-log path if the env var didn't reach us.
  if (!debugLogPath && server.debugLog) debugLogPath = server.debugLog;

  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: `${HOOK_API_PREFIX}/claude`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2000,
      },
      (res) => {
        hookDebug(`POST-done event=${eventName} sid=${sid} status=${res.statusCode}`);
        res.resume();
        resolve();
      },
    );
    req.on('error', (err) => {
      hookDebug(`POST-error event=${eventName} sid=${sid} err=${err.message}`);
      resolve();
    });
    req.on('timeout', () => {
      hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
