/**
 * PTY session manager: one pseudo-terminal per launched agent.
 *
 * Owns the standalone surface's terminal lifecycle -- the role vscode.Terminal
 * plays for the extension. Keyed by agent id (1:1; multiple terminals per agent
 * is deferred, see docs/design/standalone-terminal.md).
 *
 * Detaching a browser does NOT kill the PTY: sockets come and go (reload, network
 * blip), the process outlives them, and a serialized snapshot of the mirrored
 * screen restores what was missed. Only an explicit dispose() or the process
 * exiting ends a session.
 */

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_KILL_GRACE_MS,
  TERMINAL_MIRROR_SCROLLBACK_LINES,
  TERMINAL_TERM_NAME,
} from '../constants.js';
import type { IPty, PtyModule } from './ptyModule.js';
import { resolvePtyModule } from './ptyModule.js';

export interface CreatePtySessionOptions {
  agentId: number;
  command: string;
  args: string[];
  cwd: string;
  /** Extra env layered over the server's own process.env. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

type DataListener = (chunk: string) => void;
type ExitListener = (exit: PtyExit) => void;

/** A single live (or just-exited) PTY-backed terminal. */
export class PtySession {
  readonly agentId: number;
  private readonly pty: IPty;
  /** Headless xterm mirroring the PTY's screen state. A raw byte ring can't be
   *  replayed to a fresh client — it starts mid-stream and a full-screen TUI's
   *  cursor movements assume screen state the client doesn't have (the garbled
   *  overlapping-fragments glitch on reload). The mirror parses every byte as a
   *  real terminal would, so serializing it reproduces the CURRENT screen
   *  (scrollback, colors, cursor) faithfully at any attach point. */
  private readonly mirror: HeadlessTerminal;
  private readonly serializeAddon: SerializeAddon;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exit: PtyExit | null = null;

  cols: number;
  rows: number;

  constructor(agentId: number, pty: IPty, cols: number, rows: number) {
    this.agentId = agentId;
    this.pty = pty;
    this.cols = cols;
    this.rows = rows;
    this.mirror = new HeadlessTerminal({
      cols,
      rows,
      scrollback: TERMINAL_MIRROR_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    // The addon is typed against @xterm/xterm's Terminal, but it only touches
    // the buffer API surface @xterm/headless shares (same version family).
    this.mirror.loadAddon(
      this.serializeAddon as unknown as Parameters<HeadlessTerminal['loadAddon']>[0],
    );

    this.pty.onData((chunk) => {
      this.mirror.write(chunk);
      for (const listener of this.dataListeners) listener(chunk);
    });

    this.pty.onExit((e) => {
      this.exit = { exitCode: e.exitCode, signal: e.signal };
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      for (const listener of this.exitListeners) listener(this.exit);
      this.dataListeners.clear();
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Exit status, or null while the process is still running. */
  get exitStatus(): PtyExit | null {
    return this.exit;
  }

  get hasExited(): boolean {
    return this.exit !== null;
  }

  /**
   * Serialized screen state (scrollback + screen + cursor + attributes) for
   * replay to a late-joining or reconnecting client, valid on a FRESH terminal
   * of the same geometry. Async because the mirror parses writes on its own
   * queue: the empty flush write's callback fires only after every chunk
   * received before this call has been parsed, so none are missing from the
   * snapshot (and any chunk arriving after it is exactly the live stream).
   */
  snapshot(): Promise<string> {
    return new Promise((resolve) => {
      this.mirror.write('', () => {
        resolve(this.serializeAddon.serialize());
      });
    });
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

  write(data: string): void {
    if (this.exit) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exit) return;
    if (!isValidDimension(cols) || !isValidDimension(rows)) return;
    this.cols = cols;
    this.rows = rows;
    // Keep the mirror at PTY geometry, or the snapshot would lay out wrong.
    this.mirror.resize(cols, rows);
    try {
      this.pty.resize(cols, rows);
    } catch (err) {
      // Resizing races process exit; a dead PTY throwing here is expected.
      console.warn(`[Pixel Agents] Terminal: agent ${this.agentId} resize failed: ${String(err)}`);
    }
  }

  /** SIGHUP, then SIGKILL if it doesn't exit within the grace period. */
  dispose(): void {
    if (this.exit) return;
    try {
      this.pty.kill();
    } catch {
      // Already gone.
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.exit) return;
      try {
        this.pty.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, TERMINAL_KILL_GRACE_MS);
    // Don't hold the event loop open just to escalate a kill on shutdown.
    this.killTimer.unref?.();
  }
}

function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 1000;
}

export class PtySessionManager {
  private readonly sessions = new Map<number, PtySession>();
  private resolution: ReturnType<typeof resolvePtyModule> | null = null;

  /** Injectable for tests; production resolves the real optional native module. */
  constructor(
    private readonly resolve: () => ReturnType<typeof resolvePtyModule> = resolvePtyModule,
  ) {}

  /**
   * A manager that is permanently unavailable with the given reason, for when
   * the operator opts out (--no-terminal). Every consumer -- the availability
   * broadcast, the session route, the launcher -- already handles "unavailable",
   * so a disabled manager needs no special-casing anywhere downstream, and the
   * native module is never resolved or probed.
   */
  static disabled(reason: string): PtySessionManager {
    return new PtySessionManager(() => ({ module: null, moduleId: null, reason }));
  }

  /** Resolve (once) and cache the PTY module. Lazy: a user who never opens a
   *  terminal never pays the probe's spawn. */
  private ensureResolved(): ReturnType<typeof resolvePtyModule> {
    this.resolution ??= this.resolve();
    return this.resolution;
  }

  isAvailable(): boolean {
    return this.ensureResolved().module !== null;
  }

  /** Why the terminal is unavailable, or null when it works. */
  unavailableReason(): string | null {
    return this.ensureResolved().reason;
  }

  /** Module id actually in use (diagnostics/logging only). */
  moduleId(): string | null {
    return this.ensureResolved().moduleId;
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Spawn a PTY for an agent. Throws when no PTY module is available -- callers
   * must check isAvailable() first (the UI gates on the broadcast availability,
   * so reaching here unavailable is a programming error, not a user path).
   */
  create(options: CreatePtySessionOptions): PtySession {
    const { module } = this.ensureResolved();
    if (!module) {
      throw new Error(this.unavailableReason() ?? 'PTY module unavailable');
    }

    // Replacing an existing session would silently orphan its process.
    this.dispose(options.agentId);

    const cols = options.cols ?? TERMINAL_DEFAULT_COLS;
    const rows = options.rows ?? TERMINAL_DEFAULT_ROWS;
    const session = new PtySession(
      options.agentId,
      spawnPty(module, options, cols, rows),
      cols,
      rows,
    );
    this.sessions.set(options.agentId, session);

    // Self-evict on exit so a crashed process doesn't leave a session that
    // reports "available" to a reconnecting browser forever.
    session.onExit(() => {
      if (this.sessions.get(options.agentId) === session) {
        this.sessions.delete(options.agentId);
      }
    });

    return session;
  }

  get(agentId: number): PtySession | undefined {
    return this.sessions.get(agentId);
  }

  has(agentId: number): boolean {
    return this.sessions.has(agentId);
  }

  write(agentId: number, data: string): void {
    this.sessions.get(agentId)?.write(data);
  }

  resize(agentId: number, cols: number, rows: number): void {
    this.sessions.get(agentId)?.resize(cols, rows);
  }

  /** Kill and forget an agent's terminal. No-op when there isn't one. */
  dispose(agentId: number): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    session.dispose();
  }

  /** Kill every terminal. Called on server shutdown. */
  disposeAll(): void {
    for (const agentId of [...this.sessions.keys()]) {
      this.dispose(agentId);
    }
  }
}

function spawnPty(
  module: PtyModule,
  options: CreatePtySessionOptions,
  cols: number,
  rows: number,
): IPty {
  // Drop undefined values: process.env is `string | undefined`-valued, but the
  // PTY env must be all-strings.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env ?? {}, { TERM: TERMINAL_TERM_NAME });

  return module.spawn(options.command, options.args, {
    name: TERMINAL_TERM_NAME,
    cols,
    rows,
    cwd: options.cwd,
    env,
  });
}
