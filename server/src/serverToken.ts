import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR, STANDALONE_TOKEN_FILE_NAME } from './constants.js';

/** A token we wrote ourselves is a UUID; anything else in the file is treated
 *  as damage and replaced rather than handed to the auth gate. */
const USABLE_TOKEN = /^[A-Za-z0-9-]{16,128}$/;

/**
 * The standalone server's token, persisted across restarts.
 *
 * The token is the ONLY thing that makes a standalone browser session
 * privileged (hooks toggle, launching agents, attaching to their terminals --
 * see httpServer.ts standaloneTokenValid), and it reaches the browser inside
 * the URL the CLI prints. A per-process token would invalidate that URL on
 * every restart, so a bookmark or a home-screen web app pointing at a
 * long-running server (a background service on an always-on machine) would need a
 * fresh copy each time. Persisting it keeps the printed URL stable.
 *
 * Stored on its own, mode 0600, beside server.json -- never in config.json,
 * which is world-readable and rewritten wholesale by every settings change.
 * The file's own mode is the protection: ~/.pixel-agents is usually created
 * earlier by config or layout persistence with the default directory mode, and
 * mkdir never tightens an existing directory. Falls back to a per-process
 * token when the file cannot be written, so a read-only HOME still gets a
 * working (if unstable) server.
 *
 * A persisted token never expires, so `rotate` is the revocation path for a
 * leaked URL: it mints a fresh token and overwrites the file, and every URL
 * carrying the old one -- on every device -- stops granting privilege.
 */
export function loadOrCreateStandaloneToken({ rotate = false } = {}): string {
  const dir = path.join(os.homedir(), SERVER_JSON_DIR);
  const file = path.join(dir, STANDALONE_TOKEN_FILE_NAME);
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
    // tmp + rename: a rotation replaces the file whole (never a torn token),
    // and the new inode is created 0600 even if the old one was looser.
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    // A rotation that didn't land would bring the leaked token back on the
    // next start; fail loudly instead of running on a per-process token.
    if (rotate) {
      throw new Error(
        `Could not rotate the server token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.warn(
      `[Pixel Agents] Could not persist the server token (${err instanceof Error ? err.message : String(err)}); using a per-process token.`,
    );
  }
  return token;
}
