/**
 * The standalone terminal surface, as the rest of the server sees it.
 *
 * Two implementations:
 * - PtySessionManager (the default, and the only one that ships): PTYs live in
 *   the server process and die with it.
 * - RemotePtySessions (development only, `--pty-host`): PTYs live in a separate
 *   long-lived process, so restarting the server leaves every agent running and
 *   the next server reattaches to them (see ptyHost.ts).
 */

export interface CreateTerminalOptions {
  agentId: number;
  command: string;
  args: string[];
  cwd: string;
  /** The whole environment the terminal runs with (TERM is set over it). */
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
}

/**
 * A screen to replay to a fresh terminal, and where in the output stream it
 * was taken: every chunk numbered `seq` or lower is already drawn in it, every
 * later one is not. That is what lets a client attach mid-stream without a
 * byte dropped or doubled.
 */
export interface TerminalReplay {
  data: string;
  seq: number;
  cols: number;
  rows: number;
}

/** One agent's terminal. */
export interface TerminalSession {
  readonly agentId: number;
  /** The process id, or null while a remote spawn is still in flight. */
  readonly pid: number | null;
  readonly cols: number;
  readonly rows: number;
  readonly hasExited: boolean;
  /** Output chunks, numbered 1, 2, 3… in order (see TerminalReplay). */
  onData(listener: (chunk: string, seq: number) => void): () => void;
  /** Fires once. Registered after the exit, it still fires (asynchronously). */
  onExit(listener: (exit: TerminalExit) => void): () => void;
  replay(): Promise<TerminalReplay>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** Every agent's terminal: what launch, attach, close and shutdown act on. */
export interface TerminalSessions {
  /** Whether the operator enabled the terminal (false with --no-terminal). */
  readonly enabled: boolean;
  isAvailable(): boolean;
  /** Why the terminal is unavailable, or null when it works. */
  unavailableReason(): string | null;
  /** The PTY module in use (diagnostics only). */
  moduleId(): string | null;
  /** Spawn a terminal for an agent. Throws when unavailable. */
  create(options: CreateTerminalOptions): TerminalSession;
  get(agentId: number): TerminalSession | undefined;
  has(agentId: number): boolean;
  /** Kill and forget an agent's terminal. No-op when there isn't one. */
  dispose(agentId: number): void;
  /** Terminals still running from before this server started: they
   *  outlived a restart (the saved agent list says whose they are). */
  survivors(): TerminalSession[];
  /** The server is stopping. In process: kill every terminal and wait for
   *  them (each exit closes its agent). With the PTY host: just disconnect,
   *  leaving them running. */
  shutdown(): Promise<void>;
}

type DataListener = (chunk: string, seq: number) => void;
type ExitListener = (exit: TerminalExit) => void;

/**
 * A TerminalSession's output and exit events, shared by both implementations
 * so the listener contract lives in one place: chunks are numbered, the exit
 * fires once (listeners first, then every listener is dropped), and a listener
 * registered after the exit still gets it, on a microtask.
 */
export class TerminalEvents {
  private seq = 0;
  private exit: TerminalExit | null = null;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  /** Number of the last output chunk (see TerminalReplay). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Exit status, or null while the process is still running. */
  get exitStatus(): TerminalExit | null {
    return this.exit;
  }

  get hasExited(): boolean {
    return this.exit !== null;
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    // A listener registered after the process already exited would otherwise
    // never fire -- the socket would hang waiting for an event in the past.
    if (this.exit) {
      const exit = this.exit;
      queueMicrotask(() => listener(exit));
      return () => {
        /* already delivered */
      };
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Fan a chunk out, numbered `seq` (the next number unless given). */
  emitData(chunk: string, seq = this.seq + 1): void {
    this.seq = seq;
    for (const listener of this.dataListeners) listener(chunk, seq);
  }

  /** Record the exit and fire it, once; later calls are ignored. */
  emitExit(exit: TerminalExit): void {
    if (this.exit) return;
    this.exit = exit;
    for (const listener of this.exitListeners) listener(exit);
    this.detach();
  }

  /** Drop every listener without firing them. */
  detach(): void {
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}
