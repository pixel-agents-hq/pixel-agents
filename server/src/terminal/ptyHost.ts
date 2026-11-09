/**
 * The PTY host: a small long-lived process that owns the agents' terminals, so
 * the server can restart without killing them. Development only, opted into
 * with `pixel-agents --pty-host`; the shipped office keeps its terminals in
 * process (PtySessionManager) and stops them when it stops.
 *
 * The host is deliberately thin and rarely changes — it is the one piece a
 * server update does NOT replace. It wraps the same PtySessionManager the
 * in-process mode uses (so screens are mirrored and replayed the same way)
 * and speaks ptyHostProtocol.ts to whichever server is connected. Restarting
 * the host itself ends every agent; it exits on its own once it has had no
 * terminal and no server for PTY_HOST_IDLE_EXIT_MS.
 *
 * SECURITY: the socket spawns shells as the user. It lives in a 0700
 * directory and is chmod 0600, the same model as ssh-agent: only the user (or
 * root) can connect.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { PTY_HOST_IDLE_EXIT_MS } from '../constants.js';
import type { HostMessage, HostRequest, HostSessionInfo } from './ptyHostProtocol.js';
import { encodeLine, LineDecoder, PTY_HOST_PROTOCOL } from './ptyHostProtocol.js';
import type { PtyModuleResolution } from './ptyModule.js';
import { resolvePtyModule } from './ptyModule.js';
import { PtySessionManager } from './ptySessionManager.js';

export interface PtyHostOptions {
  socketPath: string;
  /** Injectable for tests. */
  resolve?: () => PtyModuleResolution;
  idleExitMs?: number;
  /** Called once the host has been idle long enough; the entry point exits. */
  onIdle?: () => void;
}

export interface PtyHost {
  /** Stop listening and kill every terminal. */
  close(): Promise<void>;
}

interface Client {
  socket: net.Socket;
  /** Said hello with our protocol: receives the output stream. */
  ready: boolean;
}

export async function startPtyHost(options: PtyHostOptions): Promise<PtyHost> {
  const { socketPath } = options;
  const idleExitMs = options.idleExitMs ?? PTY_HOST_IDLE_EXIT_MS;
  const manager = new PtySessionManager(options.resolve ?? resolvePtyModule);
  const clients = new Set<Client>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const broadcast = (msg: HostMessage): void => {
    const line = encodeLine(msg);
    for (const client of clients) {
      if (client.ready && !client.socket.destroyed) client.socket.write(line);
    }
  };

  const checkIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (clients.size > 0 || manager.size > 0 || !options.onIdle) return;
    idleTimer = setTimeout(() => options.onIdle?.(), idleExitMs);
  };

  const sessionsInfo = (): HostSessionInfo[] =>
    [...manager.sessions()].map((session) => ({
      agentId: session.agentId,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
    }));

  const handle = (client: Client, msg: HostRequest): void => {
    const reply = (m: HostMessage): void => {
      if (!client.socket.destroyed) client.socket.write(encodeLine(m));
    };
    if (msg.t === 'hello') {
      reply({
        t: 'hello',
        protocol: PTY_HOST_PROTOCOL,
        pid: process.pid,
        moduleId: manager.moduleId(),
        reason: manager.unavailableReason(),
        sessions: msg.protocol === PTY_HOST_PROTOCOL ? sessionsInfo() : [],
      });
      // A server speaking another protocol only learns ours, then hangs up.
      client.ready = msg.protocol === PTY_HOST_PROTOCOL;
      return;
    }
    if (!client.ready) return;
    switch (msg.t) {
      case 'spawn': {
        const { agentId } = msg.options;
        try {
          const session = manager.create(msg.options);
          // A terminal replaced under the same id (create kills the old one)
          // must not speak for its successor.
          const current = (): boolean => (manager.get(agentId) ?? session) === session;
          session.onData((data, seq) => {
            if (current()) broadcast({ t: 'data', agentId, data, seq });
          });
          session.onExit((exit) => {
            if (!current()) return;
            console.log(`[PTY host] agent ${agentId}: exited (code ${exit.exitCode})`);
            broadcast({ t: 'exit', agentId, exitCode: exit.exitCode, signal: exit.signal });
            checkIdle();
          });
          reply({ t: 'spawned', rid: msg.rid, agentId, pid: session.pid });
          console.log(
            `[PTY host] agent ${agentId}: spawned pid ${session.pid} in ${msg.options.cwd}`,
          );
        } catch (err) {
          reply({ t: 'spawnFailed', rid: msg.rid, agentId, message: String(err) });
        }
        checkIdle();
        break;
      }
      case 'write':
        manager.get(msg.agentId)?.write(msg.data);
        break;
      case 'resize':
        manager.get(msg.agentId)?.resize(msg.cols, msg.rows);
        break;
      case 'kill':
        console.log(`[PTY host] agent ${msg.agentId}: kill`);
        manager.dispose(msg.agentId);
        break;
      case 'replay': {
        const session = manager.get(msg.agentId);
        if (!session) {
          reply({ t: 'replay', rid: msg.rid, agentId: msg.agentId, replay: null });
          break;
        }
        void session.replay().then((replay) => {
          reply({ t: 'replay', rid: msg.rid, agentId: msg.agentId, replay });
        });
        break;
      }
    }
  };

  await claimSocketPath(socketPath);
  const server = net.createServer((socket) => {
    const client: Client = { socket, ready: false };
    clients.add(client);
    checkIdle();
    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => {
      for (const msg of decoder.push(chunk)) {
        if (msg && typeof msg === 'object' && 't' in msg) handle(client, msg as HostRequest);
      }
    });
    const drop = (): void => {
      clients.delete(client);
      checkIdle();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  checkIdle();

  return {
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      for (const client of clients) client.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.disposeAll();
    },
  };
}

/**
 * Make the socket path ours: create its 0700 directory, and remove a socket a
 * dead host left behind. A LIVE host there is an error — two hosts would each
 * think they own the agents.
 */
async function claimSocketPath(socketPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(socketPath)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`another PTY host is already listening on ${socketPath}`);
  fs.unlinkSync(socketPath);
}
