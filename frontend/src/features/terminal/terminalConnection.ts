import { reconnectDelayMs } from '../connection/connectionSaga';
import { serverToken } from '../connection/serverToken';
import { parseServerFrame, TERMINAL_WS_PREFIX } from '../../protocol';

export type TerminalStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface TerminalHandlers {
  onOutput(data: string): void;
  /** 每次（重新）連上的第一個畫面：以 cols x rows 排版的整個畫面快照，要取代目前內容。 */
  onReplay(data: string, cols: number, rows: number): void;
  onStatusChange(status: TerminalStatus): void;
}

/**
 * 一個 Agent 的終端機 WebSocket。PTY 在伺服器端不會因斷線而結束，
 * 重新連線會重播畫面並接續。
 */
export class TerminalConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private exited = false;
  private geometry: { cols: number; rows: number } | null = null;
  private readonly agentId: number;
  private readonly handlers: TerminalHandlers;

  constructor(agentId: number, handlers: TerminalHandlers) {
    this.agentId = agentId;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.disposed || this.exited) return;
    this.handlers.onStatusChange(this.attempt === 0 ? 'connecting' : 'reconnecting');
    if (serverToken === null) {
      this.handlers.onStatusChange('closed');
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}${TERMINAL_WS_PREFIX}/${String(this.agentId)}?token=${encodeURIComponent(serverToken)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatusChange('connected');
      if (this.geometry) this.resize(this.geometry.cols, this.geometry.rows);
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
        this.handlers.onStatusChange('closed');
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.disposed || this.exited) return;
      // 4000 號段是伺服器的應用層拒絕（token 錯誤、來源不允許、沒有這個 session），重試也不會成功
      if (event.code >= 4000 && event.code < 5000) {
        this.handlers.onStatusChange('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.handlers.onStatusChange('reconnecting');
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  write(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.geometry = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.close();
      this.socket = null;
    }
  }
}
