/**
 * Terminal data-plane client: one WebSocket per attached agent terminal.
 *
 * Deliberately NOT part of the MessageTransport abstraction. That interface
 * carries the AsyncAPI control plane (`send(msg: ClientMessage)`), and it is a
 * single multiplexed connection shared by the whole app. Terminal I/O is a
 * per-agent raw byte stream on its own socket, so forcing it through the same
 * seam would mean widening the protocol union with a message no other client can
 * use. See docs/design/standalone-terminal.md.
 */

import {
  TERMINAL_SESSION_API_PATH,
  TERMINAL_WS_PREFIX,
  TERMINAL_WS_PROTOCOL,
} from '../../../core/src/constants.js';
import { TERMINAL_RECONNECT_DELAYS_MS } from '../constants.js';

export interface TerminalSessionInfo {
  token: string;
  available: boolean;
  reason?: string;
}

/** Cached token fetch: every terminal tab needs the same token, and the endpoint
 *  is same-origin-guarded, so one request serves them all. */
let sessionPromise: Promise<TerminalSessionInfo> | null = null;

export function fetchTerminalSession(): Promise<TerminalSessionInfo> {
  sessionPromise ??= fetch(TERMINAL_SESSION_API_PATH)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`terminal session request failed: ${String(res.status)}`);
      }
      return res.json() as Promise<TerminalSessionInfo>;
    })
    .catch((err: unknown) => {
      // Never cache a failure. `??=` would otherwise pin a rejected promise
      // forever, so a single transient miss (server momentarily unreachable, a
      // reconnect racing a restart) would poison every future terminal tab and
      // no reconnect could recover even after the server returns. Clearing lets
      // the next connect()/reconnect re-fetch.
      sessionPromise = null;
      throw err;
    });
  return sessionPromise;
}

export interface TerminalConnectionHandlers {
  onOutput(data: string): void;
  /** First frame of every (re)attach: a serialized snapshot of the server-side
   *  screen, laid out at cols×rows. Replace the terminal's content with it. */
  onReplay(data: string, cols: number, rows: number): void;
  onExit(exitCode: number): void;
  onStatusChange(status: TerminalConnectionStatus): void;
}

export type TerminalConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * A reconnecting terminal socket for one agent.
 *
 * The PTY outlives the socket server-side, so a reconnect replays the scrollback
 * ring and resumes -- dropping the connection never kills the user's session.
 */
export class TerminalConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private exited = false;
  /** Last known geometry, re-sent on reconnect so a resize during a drop isn't lost. */
  private pending: { cols: number; rows: number } | null = null;

  // Declared as fields rather than constructor parameter properties:
  // `erasableSyntaxOnly` is on in the webview, and parameter properties emit
  // runtime code.
  private readonly agentId: number;
  private readonly handlers: TerminalConnectionHandlers;

  constructor(agentId: number, handlers: TerminalConnectionHandlers) {
    this.agentId = agentId;
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (this.disposed || this.exited) return;
    this.handlers.onStatusChange(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let session: TerminalSessionInfo;
    try {
      session = await fetchTerminalSession();
    } catch (err) {
      console.error('[Webview] Terminal: failed to get session token:', err);
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${TERMINAL_WS_PREFIX}/${String(this.agentId)}`;

    // The token rides as the second subprotocol value: the WebSocket API can't
    // set an Authorization header, and a ?token= query param would be written to
    // the server's request log on every connection.
    const socket = new WebSocket(url, [TERMINAL_WS_PROTOCOL, session.token]);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatusChange('connected');
      // Re-assert geometry: the fresh PTY-side socket doesn't know our size.
      if (this.pending) this.resize(this.pending.cols, this.pending.rows);
    };

    socket.onmessage = (event: MessageEvent) => {
      const frame = parseServerFrame(String(event.data));
      if (!frame) return;
      if (frame.type === 'output') {
        this.handlers.onOutput(frame.data);
      } else if (frame.type === 'replay') {
        this.handlers.onReplay(frame.data, frame.cols, frame.rows);
      } else {
        this.exited = true;
        this.handlers.onExit(frame.exitCode);
        this.handlers.onStatusChange('closed');
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.disposed || this.exited) return;
      // 4401/4404 are terminal (bad token, or no such session): retrying can't
      // fix either, and hammering an auth-rejecting endpoint is pointless.
      if (event.code >= 4000 && event.code < 5000) {
        console.error(
          `[Webview] Terminal: agent ${String(this.agentId)} rejected (${String(event.code)}: ${event.reason})`,
        );
        this.handlers.onStatusChange('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.exited || this.reconnectTimer) return;
    this.handlers.onStatusChange('reconnecting');
    const delay =
      TERMINAL_RECONNECT_DELAYS_MS[Math.min(this.attempt, TERMINAL_RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  write(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.pending = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Detach handlers before closing: onclose would otherwise schedule a
    // reconnect for a connection we're deliberately tearing down.
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
  }
}

type ServerFrame =
  | { type: 'replay'; data: string; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number };

function parseServerFrame(raw: string): ServerFrame | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === 'output' && typeof parsed.data === 'string') {
      return { type: 'output', data: parsed.data };
    }
    if (
      parsed.type === 'replay' &&
      typeof parsed.data === 'string' &&
      typeof parsed.cols === 'number' &&
      typeof parsed.rows === 'number'
    ) {
      return { type: 'replay', data: parsed.data, cols: parsed.cols, rows: parsed.rows };
    }
    if (parsed.type === 'exit') {
      return { type: 'exit', exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 0 };
    }
  } catch {
    // Malformed frame — ignore rather than break the stream.
  }
  return null;
}
