import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RELAY_TOKEN_FILE_NAME, SERVER_JSON_DIR } from './constants.js';

const USABLE_TOKEN = /^[A-Za-z0-9-]{16,128}$/;

/**
 * Load the hook-ingest credential shared by Pixel Agents server instances.
 *
 * This token is deliberately separate from the administrative server token.
 * It is accepted only by POST /api/hooks/:providerId and is stored in its own
 * mode-0600 file so an operator can provision it to a remote relay without
 * granting browser, hook-management, agent-launch, or terminal privileges.
 */
export function loadOrCreateRelayToken({ rotate = false } = {}): string {
  const dir = path.join(os.homedir(), SERVER_JSON_DIR);
  const file = path.join(dir, RELAY_TOKEN_FILE_NAME);
  if (!rotate) {
    try {
      const existing = fs.readFileSync(file, 'utf-8').trim();
      if (USABLE_TOKEN.test(existing)) return existing;
    } catch {
      // Absent or unreadable: mint below.
    }
  }

  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    if (rotate) {
      throw new Error(
        `Could not rotate the relay token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.warn(
      `[Pixel Agents] Could not persist the relay token (${err instanceof Error ? err.message : String(err)}); remote relays will stop authenticating after restart.`,
    );
  }
  return token;
}
