import { describe, expect, it, vi } from 'vitest';

import { TERMINAL_MIRROR_SCROLLBACK_LINES } from '../src/constants.js';
import type { IPty, PtyModule, PtyModuleResolution } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

/**
 * Fake PTY. Tests never spawn a real process: they'd be slow, platform-specific,
 * and would leak children on failure. The manager's contract is entirely about
 * lifecycle bookkeeping around this interface.
 */
class FakePty implements IPty {
  readonly pid = 4242;
  written: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killSignals: Array<string | undefined> = [];
  resizeThrows = false;

  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    if (this.resizeThrows) throw new Error('resize on dead pty');
    this.resizes.push({ cols, rows });
  }
  kill(signal?: string): void {
    this.killSignals.push(signal);
  }

  // -- test drivers --
  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(exitCode = 0, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

interface Harness {
  manager: PtySessionManager;
  spawned: FakePty[];
  spawnArgs: Array<{ file: string; args: string[]; options: Record<string, unknown> }>;
}

function harness(overrides: Partial<PtyModuleResolution> = {}): Harness {
  const spawned: FakePty[] = [];
  const spawnArgs: Harness['spawnArgs'] = [];
  const module: PtyModule = {
    spawn: (file, args, options) => {
      spawnArgs.push({ file, args, options: options as unknown as Record<string, unknown> });
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  };
  const manager = new PtySessionManager(() => ({
    module,
    moduleId: 'fake-pty',
    reason: null,
    ...overrides,
  }));
  return { manager, spawned, spawnArgs };
}

function create(manager: PtySessionManager, agentId = 1) {
  return manager.create({ agentId, command: 'claude', args: ['--session-id', 'x'], cwd: '/tmp' });
}

describe('PtySessionManager availability', () => {
  it('reports available when a module resolves', () => {
    const { manager } = harness();
    expect(manager.isAvailable()).toBe(true);
    expect(manager.unavailableReason()).toBeNull();
    expect(manager.moduleId()).toBe('fake-pty');
  });

  it('reports unavailable with the resolver reason', () => {
    const { manager } = harness({ module: null, moduleId: null, reason: 'no PTY module' });
    expect(manager.isAvailable()).toBe(false);
    expect(manager.unavailableReason()).toBe('no PTY module');
  });

  it('resolves lazily and only once', () => {
    // The probe spawns a real PTY in production, so it must not run at
    // construction (a user who never opens a terminal shouldn't pay for it) and
    // must not run per call.
    const resolve = vi.fn(() => ({ module: null, moduleId: null, reason: 'nope' }));
    const manager = new PtySessionManager(resolve);
    expect(resolve).not.toHaveBeenCalled();
    manager.isAvailable();
    manager.isAvailable();
    manager.unavailableReason();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('throws on create when unavailable', () => {
    const { manager } = harness({ module: null, moduleId: null, reason: 'no PTY module' });
    expect(() => create(manager)).toThrow(/no PTY module/);
  });

  it('disabled() is permanently unavailable with the given reason', () => {
    // --no-terminal path: same observable contract as a failed module resolution,
    // so everything downstream (broadcast, routes, launcher) needs no special case.
    const manager = PtySessionManager.disabled('disabled by flag');
    expect(manager.isAvailable()).toBe(false);
    expect(manager.unavailableReason()).toBe('disabled by flag');
    expect(manager.moduleId()).toBeNull();
    expect(() => create(manager)).toThrow(/disabled by flag/);
  });
});

describe('PtySessionManager lifecycle', () => {
  it('spawns with the requested command, cwd, and TERM', () => {
    const { manager, spawnArgs } = harness();
    create(manager, 7);
    expect(spawnArgs[0].file).toBe('claude');
    expect(spawnArgs[0].args).toEqual(['--session-id', 'x']);
    expect(spawnArgs[0].options.cwd).toBe('/tmp');
    expect((spawnArgs[0].options.env as Record<string, string>).TERM).toBeTruthy();
  });

  it('tracks sessions by agent id', () => {
    const { manager } = harness();
    const session = create(manager, 7);
    expect(manager.get(7)).toBe(session);
    expect(manager.has(7)).toBe(true);
    expect(manager.has(8)).toBe(false);
    expect(manager.size).toBe(1);
  });

  it('replacing an agent session kills the previous process', () => {
    // Otherwise the old Claude would keep running with nothing attached to it.
    const { manager, spawned } = harness();
    create(manager, 1);
    create(manager, 1);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].killSignals).toHaveLength(1);
    expect(manager.size).toBe(1);
  });

  it('routes write and resize to the right session', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    create(manager, 2);
    manager.write(1, 'ls\r');
    manager.resize(2, 100, 50);
    expect(spawned[0].written).toEqual(['ls\r']);
    expect(spawned[1].resizes).toEqual([{ cols: 100, rows: 50 }]);
    expect(spawned[1].written).toEqual([]);
  });

  it('ignores writes and resizes for unknown agents', () => {
    const { manager } = harness();
    expect(() => manager.write(99, 'x')).not.toThrow();
    expect(() => manager.resize(99, 80, 24)).not.toThrow();
  });

  it('rejects nonsensical resize dimensions', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    manager.resize(1, 0, 24);
    manager.resize(1, 80, -5);
    manager.resize(1, 80.5, 24);
    manager.resize(1, 99_999, 24);
    expect(spawned[0].resizes).toEqual([]);
  });

  it('survives a resize that throws on a dying pty', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    spawned[0].resizeThrows = true;
    expect(() => manager.resize(1, 80, 24)).not.toThrow();
  });

  it('dispose kills the process and forgets the session', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    manager.dispose(1);
    expect(spawned[0].killSignals).toEqual([undefined]);
    expect(manager.has(1)).toBe(false);
    expect(manager.size).toBe(0);
  });

  it('dispose of an unknown agent is a no-op', () => {
    const { manager } = harness();
    expect(() => manager.dispose(99)).not.toThrow();
  });

  it('disposeAll kills every session', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    create(manager, 2);
    manager.disposeAll();
    expect(manager.size).toBe(0);
    expect(spawned[0].killSignals).toHaveLength(1);
    expect(spawned[1].killSignals).toHaveLength(1);
  });

  it('escalates to SIGKILL when the process ignores the first kill', async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = harness();
      const session = create(manager, 1);
      session.dispose();
      expect(spawned[0].killSignals).toEqual([undefined]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(spawned[0].killSignals).toEqual([undefined, 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not escalate when the process exits within the grace period', async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = harness();
      const session = create(manager, 1);
      session.dispose();
      spawned[0].exit(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(spawned[0].killSignals).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-evicts the session when the process exits on its own', () => {
    const { manager, spawned } = harness();
    create(manager, 1);
    spawned[0].exit(0);
    expect(manager.has(1)).toBe(false);
  });
});

describe('PtySession streaming', () => {
  it('fans output out to every listener and unsubscribes cleanly', () => {
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    const a: string[] = [];
    const b: string[] = [];
    const offA = session.onData((d) => a.push(d));
    session.onData((d) => b.push(d));

    spawned[0].emit('first');
    offA();
    spawned[0].emit('second');

    expect(a).toEqual(['first']);
    expect(b).toEqual(['first', 'second']);
  });

  it('reports exit status and stops accepting writes', () => {
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    const exits: number[] = [];
    session.onExit((e) => exits.push(e.exitCode));

    spawned[0].exit(3);

    expect(exits).toEqual([3]);
    expect(session.hasExited).toBe(true);
    expect(session.exitStatus).toEqual({ exitCode: 3, signal: undefined });

    session.write('ignored');
    session.resize(10, 10);
    expect(spawned[0].written).toEqual([]);
    expect(spawned[0].resizes).toEqual([]);
  });

  it('delivers exit to a listener that subscribed after the process died', async () => {
    // The WS route attaches its exit listener after the socket opens, which can
    // land after a fast-failing process has already exited -- without this the
    // browser would wait forever for an event in the past.
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    spawned[0].exit(1);

    const exits: number[] = [];
    session.onExit((e) => exits.push(e.exitCode));
    await Promise.resolve();

    expect(exits).toEqual([1]);
  });
});

/** Drop ANSI escape sequences so assertions read the visible text only. */
function stripAnsi(data: string): string {
  return data.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\x1b[a-zA-Z=><]/g, '');
}

describe('PtySession snapshot', () => {
  it('captures emitted output for a late-joining client', async () => {
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    spawned[0].emit('hello ');
    spawned[0].emit('world');
    expect(stripAnsi(await session.snapshot())).toContain('hello world');
  });

  it('is empty before any output', async () => {
    const { manager } = harness();
    expect(stripAnsi(await create(manager, 1).snapshot())).toBe('');
  });

  it('reflects the current screen, not the raw byte history', async () => {
    // The reason the mirror exists: a raw ring would replay SECRET and the
    // clear-screen bytes verbatim into a fresh client whose screen state no
    // longer matches, garbling the result. The snapshot is the screen as it IS.
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    spawned[0].emit('SECRET\r\n');
    spawned[0].emit('\x1b[2J\x1b[3J\x1b[H'); // clear screen + scrollback, home
    spawned[0].emit('AFTER');

    const snapshot = stripAnsi(await session.snapshot());
    expect(snapshot).toContain('AFTER');
    expect(snapshot).not.toContain('SECRET');
  });

  it('bounds retained scrollback, keeping the most recent lines', async () => {
    const { manager, spawned } = harness();
    const session = create(manager, 1);
    const total = TERMINAL_MIRROR_SCROLLBACK_LINES + 1_000;
    const lines = Array.from({ length: total }, (_, i) => `L${String(i).padStart(6, '0')}`);
    spawned[0].emit(lines.join('\r\n'));

    const snapshot = stripAnsi(await session.snapshot());
    expect(snapshot).toContain(`L${String(total - 1).padStart(6, '0')}`);
    expect(snapshot).not.toContain('L000000');
  });
});
