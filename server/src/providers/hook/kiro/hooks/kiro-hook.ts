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
import type { ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';
import {
  KIRO_HOOK_HTTP_TIMEOUT_MS,
  KIRO_HOOK_MAX_INPUT_BYTES,
  KIRO_SESSION_ENV,
} from '../constants.js';
import { makeKiroHookPayload } from '../kiroHookPayload.js';

function targets(): ServerTarget[] {
  const root = path.join(os.homedir(), SERVER_JSON_DIR);
  const result: ServerTarget[] = [];
  try {
    for (const file of fs.readdirSync(path.join(root, SERVERS_DIR))) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(
          fs.readFileSync(path.join(root, SERVERS_DIR, file), 'utf8'),
        );
        if (isServerConfig(value)) {
          process.kill(value.pid, 0);
          result.push(value);
        }
      } catch {
        /* stale or invalid discovery entries are harmless */
      }
    }
  } catch {
    /* legacy single-server discovery below */
  }
  if (!result.length) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(root, SERVER_JSON_NAME), 'utf8'));
      if (isServerTarget(value)) {
        result.push(value);
      }
    } catch {
      /* the office is not running */
    }
  }
  return result;
}

function post(target: ServerTarget, body: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: target.port,
          method: 'POST',
          path: `${HOOK_API_PREFIX}/kiro`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${target.token}`,
          },
          timeout: KIRO_HOOK_HTTP_TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          resolve();
        },
      );
      request.on('error', () => resolve());
      request.on('timeout', () => {
        request.destroy();
        resolve();
      });
      request.end(body);
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > KIRO_HOOK_MAX_INPUT_BYTES) {
      return;
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return;
  }
  const payload = makeKiroHookPayload(raw, process.argv[2] ?? '', process.env[KIRO_SESSION_ENV]);
  if (!payload) {
    return;
  }
  await Promise.all(targets().map((target) => post(target, JSON.stringify(payload))));
}

// Hooks are observational: a stopped office must never block a Kiro tool.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
