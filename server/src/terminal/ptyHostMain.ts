/**
 * Entry point of the PTY host process (dist/pty-host.js). Development only:
 * started by `pixel-agents --pty-host` when no host is running, detached in
 * its own session so a server restart (or launchd stopping the server's job)
 * leaves it, and the agents in it, alone. See ptyHost.ts.
 *
 *   node dist/pty-host.js [--socket <path>]
 *
 * Stopping it (SIGTERM / SIGINT) ends every agent it holds.
 */

import { startPtyHost } from './ptyHost.js';
import { defaultPtyHostSocket, socketPathProblem } from './ptyHostProtocol.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--socket');
  const socketPath = at >= 0 && argv[at + 1] ? argv[at + 1] : defaultPtyHostSocket();
  const problem = socketPathProblem(socketPath);
  if (problem) throw new Error(problem);

  let closing = false;
  const stop = (reason: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[PTY host] stopping (${reason})`);
    void host.close().finally(() => process.exit(0));
  };

  const host = await startPtyHost({ socketPath, onIdle: () => stop('idle') });
  console.log(`[PTY host] pid ${process.pid} listening on ${socketPath}`);

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // No terminal to hang up: detached in its own session. Ignore a stray one.
  process.on('SIGHUP', () => {});
}

main().catch((err) => {
  console.error(`[PTY host] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
