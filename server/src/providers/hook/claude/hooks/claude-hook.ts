import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../../../constants.js';
import type { ServerConfig } from '../../../../server.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  let server: ServerConfig;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const body = JSON.stringify(data);
  // For PreToolUse, the server may hold the response while it waits for a window
  // approval, so allow a long socket timeout (kept under Claude's 10-min hook cap).
  // If the server replies with {"decision":"allow"|"deny"}, forward it to Claude.
  const isPreToolUse = data.hook_event_name === 'PreToolUse';
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
        timeout: isPreToolUse ? 595_000 : 2000,
      },
      (res) => {
        if (!isPreToolUse) {
          // Drain and ignore the response for non-PreToolUse events.
          res.resume();
          res.on('end', () => resolve());
          return;
        }
        let respBody = '';
        res.on('data', (chunk) => (respBody += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(respBody) as { decision?: string };
            if (parsed.decision === 'allow' || parsed.decision === 'deny') {
              process.stdout.write(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: parsed.decision,
                    permissionDecisionReason: 'Decided from the Pixel Agents window',
                  },
                }),
              );
            }
          } catch {
            // Plain "ok" (no decision): let Claude handle permissions normally.
          }
          resolve();
        });
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
