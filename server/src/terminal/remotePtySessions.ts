/**
 * The server's side of the PTY host (development only, `--pty-host`): the
 * agents' terminals as TerminalSessions, living in the host process instead of
 * this one. Connecting starts a host when none is running, detached in its own
 * session so it outlives this server; shutting down only disconnects.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import {
  PTY_HOST_CONNECT_RETRY_MS,
  PTY_HOST_REQUEST_TIMEOUT_MS,
  PTY_HOST_START_TIMEOUT_MS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from '../constants.js';
import type {
  HostMessage,
  HostQuery,
  HostReply,
  HostRequest,
  HostSessionInfo,
} from './ptyHostProtocol.js';
import { encodeLine, LineDecoder, PTY_HOST_PROTOCOL } from './ptyHostProtocol.js';
import type {
  CreateTerminalOptions,
  TerminalExit,
  TerminalReplay,
  TerminalSession,
  TerminalSessions,
} from './terminalSessions.js';
import { TerminalEvents } from './terminalSessions.js';

/** What a session needs of its connection. */
interface HostLink {
  send(msg: HostRequest): void;
  request<Q extends HostQuery>(msg: Q): Promise<HostReply<Q>>;
}

/** One agent's terminal, held by the host. */
class RemoteSession implements TerminalSession {
  pid: number | null;
  cols: number;
  rows: number;
  /** Its last chunk number is also the seq of a replay the host can no longer give. */
  private readonly events = new TerminalEvents();

  constructor(
    readonly agentId: number,
    private readonly host: HostLink,
    info: { pid: number | null; cols: number; rows: number },
  ) {
    this.pid = info.pid;
    this.cols = info.cols;
    this.rows = info.rows;
  }

  get hasExited(): boolean {
    return this.events.hasExited;
  }

  onData(listener: (chunk: string, seq: number) => void): () => void {
    return this.events.onData(listener);
  }

  onExit(listener: (exit: TerminalExit) => void): () => void {
    return this.events.onExit(listener);
  }

  async replay(): Promise<TerminalReplay> {
    const empty = { data: '', seq: this.events.lastSeq, cols: this.cols, rows: this.rows };
    if (this.hasExited) return empty;
    try {
      const reply = await this.host.request({ t: 'replay', agentId: this.agentId });
      return reply.replay ?? empty;
    } catch {
      return empty;
    }
  }

  write(data: string): void {
    if (!this.hasExited) this.host.send({ t: 'write', agentId: this.agentId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.hasExited) return;
    this.cols = cols;
    this.rows = rows;
    this.host.send({ t: 'resize', agentId: this.agentId, cols, rows });
  }

  // -- driven by the connection --
  receiveData(data: string, seq: number): void {
    this.events.emitData(data, seq);
  }

  receiveExit(exit: TerminalExit): void {
    this.events.emitExit(exit);
  }

  /** The server is going away: drop listeners without firing them. */
  detach(): void {
    this.events.detach();
  }
}

export interface ConnectPtyHostOptions {
  socketPath: string;
  /** Starts a host process. Called when nothing listens on the socket. */
  startHost?: () => void;
}

export class RemotePtySessions implements TerminalSessions {
  readonly enabled = true;

  private readonly sessions = new Map<number, RemoteSession>();
  private readonly pending = new Map<number, (msg: HostMessage) => void>();
  private readonly surviving: RemoteSession[];
  /** What each session talks to the host through. */
  private readonly link: HostLink = {
    send: (msg) => this.send(msg),
    request: (query) => this.request(query),
  };
  private rid = 0;
  private connected = true;
  private closing = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly hello: Extract<HostMessage, { t: 'hello' }>,
  ) {
    this.surviving = hello.sessions.map((info) => this.track(info));
  }

  /** Connect to the host, starting one if none is running. Throws when no
   *  host comes up, or the one running speaks another protocol. */
  static async connect(options: ConnectPtyHostOptions): Promise<RemotePtySessions> {
    let socket = await tryConnect(options.socketPath);
    if (!socket) {
      options.startHost?.();
      const deadline = Date.now() + PTY_HOST_START_TIMEOUT_MS;
      while (!socket && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, PTY_HOST_CONNECT_RETRY_MS));
        socket = await tryConnect(options.socketPath);
      }
      if (!socket) throw new Error(`no PTY host came up on ${options.socketPath}`);
    }

    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    const early: HostMessage[] = [];
    const hello = await new Promise<Extract<HostMessage, { t: 'hello' }>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the PTY host did not answer')),
        PTY_HOST_REQUEST_TIMEOUT_MS,
      );
      const onData = (chunk: string): void => {
        for (const msg of decoder.push(chunk) as HostMessage[]) {
          if (msg.t === 'hello') {
            clearTimeout(timer);
            socket.off('data', onData);
            resolve(msg);
          } else {
            early.push(msg);
          }
        }
      };
      socket.on('data', onData);
      socket.once('close', () => reject(new Error('the PTY host hung up')));
      socket.write(encodeLine({ t: 'hello', protocol: PTY_HOST_PROTOCOL }));
    });
    if (hello.protocol !== PTY_HOST_PROTOCOL) {
      socket.destroy();
      throw new Error(
        `the running PTY host (pid ${hello.pid}) speaks protocol ${hello.protocol}, this server ${PTY_HOST_PROTOCOL}. ` +
          `Stop it (kill ${hello.pid} — this ends its agents) and start the server again.`,
      );
    }

    const sessions = new RemotePtySessions(socket, hello);
    socket.removeAllListeners('close');
    socket.on('data', (chunk: string) => {
      for (const msg of decoder.push(chunk)) sessions.receive(msg as HostMessage);
    });
    for (const msg of early) sessions.receive(msg);
    socket.on('close', () => sessions.lost());
    socket.on('error', () => sessions.lost());
    return sessions;
  }

  /** The host's pid (diagnostics). */
  get hostPid(): number {
    return this.hello.pid;
  }

  isAvailable(): boolean {
    return this.connected && this.hello.moduleId !== null;
  }

  unavailableReason(): string | null {
    if (!this.connected) return 'The PTY host stopped. Restart the server to start a new one.';
    return this.hello.reason;
  }

  moduleId(): string | null {
    return this.hello.moduleId;
  }

  create(options: CreateTerminalOptions): TerminalSession {
    if (!this.isAvailable()) {
      throw new Error(this.unavailableReason() ?? 'PTY host unavailable');
    }
    this.dispose(options.agentId);
    const cols = options.cols ?? TERMINAL_DEFAULT_COLS;
    const rows = options.rows ?? TERMINAL_DEFAULT_ROWS;
    const session = this.track({ agentId: options.agentId, pid: null, cols, rows });
    void this.request({ t: 'spawn', options }).then(
      (reply) => {
        if (reply.t === 'spawned') {
          session.pid = reply.pid;
        } else {
          console.error(
            `[Pixel Agents] PTY host: agent ${options.agentId} spawn failed: ${reply.message}`,
          );
          this.sessions.delete(options.agentId);
          session.receiveExit({ exitCode: -1 });
        }
      },
      () => {
        this.sessions.delete(options.agentId);
        session.receiveExit({ exitCode: -1 });
      },
    );
    return session;
  }

  get(agentId: number): TerminalSession | undefined {
    return this.sessions.get(agentId);
  }

  has(agentId: number): boolean {
    return this.sessions.has(agentId);
  }

  dispose(agentId: number): void {
    if (!this.sessions.has(agentId)) return;
    this.sessions.delete(agentId);
    this.send({ t: 'kill', agentId });
  }

  survivors(): TerminalSession[] {
    return this.surviving.filter((s) => this.sessions.get(s.agentId) === s);
  }

  /** Disconnect, leaving every terminal running in the host. */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const session of this.sessions.values()) session.detach();
    await new Promise<void>((resolve) => this.socket.end(resolve));
  }

  // ── Connection ──────────────────────────────────────────────

  private track(
    info: Pick<HostSessionInfo, 'agentId' | 'cols' | 'rows'> & { pid: number | null },
  ): RemoteSession {
    const session = new RemoteSession(info.agentId, this.link, info);
    this.sessions.set(info.agentId, session);
    return session;
  }

  private send(msg: HostRequest): void {
    if (this.connected && !this.socket.destroyed) this.socket.write(encodeLine(msg));
  }

  /** Send a query and wait for its reply (numbered here, matched by `rid`). */
  private request<Q extends HostQuery>(query: Q): Promise<HostReply<Q>> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('PTY host disconnected'));
        return;
      }
      const rid = ++this.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('PTY host request timed out'));
      }, PTY_HOST_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, (reply) => {
        clearTimeout(timer);
        // The host answers a query with its reply kind (ptyHostProtocol.ts).
        resolve(reply as HostReply<Q>);
      });
      this.send({ ...query, rid });
    });
  }

  private receive(msg: HostMessage): void {
    switch (msg.t) {
      case 'data':
        this.sessions.get(msg.agentId)?.receiveData(msg.data, msg.seq);
        break;
      case 'exit': {
        const session = this.sessions.get(msg.agentId);
        if (!session) break;
        this.sessions.delete(msg.agentId);
        session.receiveExit({ exitCode: msg.exitCode, signal: msg.signal });
        break;
      }
      case 'spawned':
      case 'spawnFailed':
      case 'replay': {
        const resolve = this.pending.get(msg.rid);
        this.pending.delete(msg.rid);
        resolve?.(msg);
        break;
      }
    }
  }

  /** The host went away: its terminals died with it. */
  private lost(): void {
    if (!this.connected) return;
    this.connected = false;
    if (this.closing) return;
    console.error('[Pixel Agents] PTY host connection lost: its terminals are gone.');
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.receiveExit({ exitCode: -1 });
  }
}

/** A connected socket, or null when nothing listens there. */
function tryConnect(socketPath: string): Promise<net.Socket | null> {
  if (!fs.existsSync(socketPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', () => resolve(null));
  });
}

/**
 * Start the host as its own process: detached into a new session (so neither
 * a server restart nor launchd stopping the server's process group reaches
 * it), output appended to its log file.
 */
export function startPtyHostProcess(script: string, socketPath: string, logFile: string): void {
  if (!fs.existsSync(script)) {
    throw new Error(
      `--pty-host needs ${script}, which only a development build has (npm run compile).`,
    );
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [script, '--socket', socketPath], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  console.log(`[Pixel Agents] Started a PTY host (pid ${child.pid}), log: ${logFile}`);
}
