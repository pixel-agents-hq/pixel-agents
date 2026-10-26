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
  TERMINAL_MOUSE_ENCODING_MODES,
  TERMINAL_SHUTDOWN_SLACK_MS,
  TERMINAL_TERM_NAME,
} from '../constants.js';
import type { IPty, PtyModule } from './ptyModule.js';
import { resolvePtyModule } from './ptyModule.js';
import type {
  CreateTerminalOptions,
  TerminalExit,
  TerminalReplay,
  TerminalSession,
  TerminalSessions,
} from './terminalSessions.js';
import { TerminalEvents } from './terminalSessions.js';

/**
 * The mode that restores the mirror's mouse encoding ('' for the default).
 * The serialize addon restores mouse tracking but not its encoding, and
 * neither xterm exposes the encoding publicly: without it a fresh client
 * reports wheels in the old X10 bytes, which an SGR TUI (Claude Code)
 * ignores — touch scrolling was dead after every reload or reconnect.
 */
function mouseEncodingMode(mirror: HeadlessTerminal): string {
  const core = (mirror as unknown as { _core?: { coreMouseService?: { activeEncoding?: string } } })
    ._core;
  const encoding = core?.coreMouseService?.activeEncoding;
  return (encoding && TERMINAL_MOUSE_ENCODING_MODES[encoding]) ?? '';
}

/** A single live (or just-exited) PTY-backed terminal. */
export class PtySession implements TerminalSession {
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
  private readonly events = new TerminalEvents();
  private killTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.events.emitData(chunk);
    });

    this.pty.onExit((e) => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.events.emitExit({ exitCode: e.exitCode, signal: e.signal });
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Exit status, or null while the process is still running. */
  get exitStatus(): TerminalExit | null {
    return this.events.exitStatus;
  }

  get hasExited(): boolean {
    return this.events.hasExited;
  }

  /**
   * Serialized screen state (scrollback + screen + cursor + attributes) for
   * replay to a late-joining or reconnecting client, valid on a FRESH terminal
   * of the same geometry, numbered: it holds every chunk up to `seq` (the
   * chunks received before this call), and none after. Async because the
   * mirror parses writes on its own queue: the empty flush write's callback
   * fires only after every chunk received before this call has been parsed.
   */
  replay(): Promise<TerminalReplay> {
    const seq = this.events.lastSeq;
    return new Promise((resolve) => {
      this.mirror.write('', () => {
        const data = this.serializeAddon.serialize() + mouseEncodingMode(this.mirror);
        resolve({ data, seq, cols: this.cols, rows: this.rows });
      });
    });
  }

  onData(listener: (chunk: string, seq: number) => void): () => void {
    return this.events.onData(listener);
  }

  onExit(listener: (exit: TerminalExit) => void): () => void {
    return this.events.onExit(listener);
  }

  write(data: string): void {
    if (this.hasExited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.hasExited) return;
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
    if (this.hasExited) return;
    try {
      this.pty.kill();
    } catch {
      // Already gone.
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.hasExited) return;
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

export class PtySessionManager implements TerminalSessions {
  private readonly byAgent = new Map<number, PtySession>();
  private resolution: ReturnType<typeof resolvePtyModule> | null = null;
  /** True for a manager built by disabled(): the operator opted out, as opposed
   *  to the PTY module failing to load. Recorded in the server registry. */
  private disabledByOperator = false;

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
    const manager = new PtySessionManager(() => ({ module: null, moduleId: null, reason }));
    manager.disabledByOperator = true;
    return manager;
  }

  /** Whether the operator enabled the terminal (no probe: module failures are
   *  a runtime fact, the opt-out is the operator's request). */
  get enabled(): boolean {
    return !this.disabledByOperator;
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
    return this.byAgent.size;
  }

  /** Every live terminal, in spawn order. */
  sessions(): IterableIterator<PtySession> {
    return this.byAgent.values();
  }

  /**
   * Spawn a PTY for an agent. Throws when no PTY module is available -- callers
   * must check isAvailable() first (the UI gates on the broadcast availability,
   * so reaching here unavailable is a programming error, not a user path).
   */
  create(options: CreateTerminalOptions): PtySession {
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
    this.byAgent.set(options.agentId, session);

    // Self-evict on exit so a crashed process doesn't leave a session that
    // reports "available" to a reconnecting browser forever.
    session.onExit(() => {
      if (this.byAgent.get(options.agentId) === session) {
        this.byAgent.delete(options.agentId);
      }
    });

    return session;
  }

  get(agentId: number): PtySession | undefined {
    return this.byAgent.get(agentId);
  }

  has(agentId: number): boolean {
    return this.byAgent.has(agentId);
  }

  /** Kill and forget an agent's terminal. No-op when there isn't one. */
  dispose(agentId: number): void {
    const session = this.byAgent.get(agentId);
    if (!session) return;
    this.byAgent.delete(agentId);
    session.dispose();
  }

  /** Nothing outlives an in-process manager's server. */
  survivors(): TerminalSession[] {
    return [];
  }

  shutdown(): Promise<void> {
    return this.disposeAll();
  }

  /**
   * Kill every terminal. Called on server shutdown, which must await it: the
   * SIGKILL escalation is a timer, and a process that exits first never runs it
   * — a child that ignores SIGHUP would outlive the server. Resolves once every
   * process has exited, or shortly after the escalation as a backstop (this
   * timer is ref'd, so it also keeps the event loop alive until then).
   */
  disposeAll(): Promise<void> {
    const sessions = [...this.byAgent.values()];
    for (const agentId of [...this.byAgent.keys()]) {
      this.dispose(agentId);
    }
    if (sessions.length === 0) return Promise.resolve();
    const exited = Promise.all(
      sessions.map((session) => new Promise<void>((resolve) => session.onExit(() => resolve()))),
    );
    let backstop: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      backstop = setTimeout(resolve, TERMINAL_KILL_GRACE_MS + TERMINAL_SHUTDOWN_SLACK_MS);
    });
    return Promise.race([exited.then(() => undefined), timedOut]).finally(() =>
      clearTimeout(backstop),
    );
  }
}

function spawnPty(
  module: PtyModule,
  options: CreateTerminalOptions,
  cols: number,
  rows: number,
): IPty {
  return module.spawn(options.command, options.args, {
    name: TERMINAL_TERM_NAME,
    cols,
    rows,
    cwd: options.cwd,
    env: { ...options.env, TERM: TERMINAL_TERM_NAME },
  });
}
