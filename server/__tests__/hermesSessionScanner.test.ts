import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionScannerContext } from '../../core/src/provider.js';
import { HERMES_SCANNER_REAP_REASON } from '../src/providers/hook/hermes/constants.js';
import {
  createHermesSessionScanner,
  type HermesScannerDeps,
  subagentStatusLabel,
} from '../src/providers/hook/hermes/hermesSessionScanner.js';
import type {
  HermesLease,
  HermesMessageRecord,
  HermesSessionRecord,
  HermesSessionStore,
} from '../src/providers/hook/hermes/hermesSessionStore.js';

/**
 * The scanner's state machine, driven against injected fakes: no temp files,
 * no real pids — start() runs the first tick synchronously, and each tick()
 * advances the fake timer by exactly one interval. Everything that matters —
 * transition dedupe, liveness verdicts, adoption policy, message replay,
 * child correlation — is pure bookkeeping over the store's shapes, so the
 * fakes speak exactly those shapes.
 *
 * Session freshness is a deliberate fixture choice: rows YOUNGER than the
 * scanner's creation replay from id 0; older ones start at the tail ("no
 * history flash"), so `young()` marks the born-after-us case explicitly.
 */

function session(overrides: Partial<HermesSessionRecord> & { id: string }): HermesSessionRecord {
  return {
    source: 'cli',
    cwd: '/work/one',
    title: 'a session',
    parentSessionId: null,
    startedAtMs: Date.now() - 60_000, // predates creation → cursor at tail
    lastActivityMs: Date.now() - 30_000,
    activityDescription: '',
    ...overrides,
  };
}

function young(overrides: Partial<HermesSessionRecord> & { id: string }): HermesSessionRecord {
  return session({ startedAtMs: Date.now() + 10_000, ...overrides });
}

function message(overrides: Partial<HermesMessageRecord> & { id: number }): HermesMessageRecord {
  return {
    role: 'user',
    toolCallId: null,
    toolCalls: [],
    hasText: false,
    timestampMs: 0,
    ...overrides,
  };
}

interface FakeSession extends HermesSessionRecord {
  endedAt: number | null;
  missing?: boolean;
}

interface FakeWorld {
  sessions: Map<string, FakeSession>;
  messages: Map<string, HermesMessageRecord[]>;
  leases: HermesLease[];
  deadPids: Set<number>;
}

function emptyWorld(): FakeWorld {
  return { sessions: new Map(), messages: new Map(), leases: [], deadPids: new Set() };
}

function makeStore(world: FakeWorld): HermesSessionStore {
  return {
    listLiveSessions: () =>
      [...world.sessions.values()].filter((s) => s.endedAt === null && !s.missing),
    endedAtOf: (id: string) => {
      const s = world.sessions.get(id);
      if (!s || s.missing) return undefined;
      return s.endedAt;
    },
    listMessagesAfter: (id: string, after: number, limit: number) =>
      (world.messages.get(id) ?? []).filter((m) => m.id > after).slice(0, limit),
    latestMessageId: (id: string) => {
      const list = world.messages.get(id) ?? [];
      return list.length ? list[list.length - 1].id : 0;
    },
    listDirectorySuggestions: () => [],
    close: () => {},
  };
}

function buildScanner(
  world: FakeWorld,
  seedLive: string[] = [],
  intervalMs = 1,
  opts: { emitStages?: boolean } = {},
) {
  const emitStages = opts.emitStages ?? true;
  const emitted: Record<string, unknown>[] = [];
  const live = new Set<string>(seedLive);
  const trackedDirs = new Set<string>();
  let watchAll = false;

  const ctx: SessionScannerContext = {
    providerId: 'hermes',
    emit: (event) => {
      emitted.push(event);
      // Mirror the real pipeline's EFFECT: once a root's birth two-beat has
      // been delivered, the router holds it (pending or registered), so
      // isSessionLive is true from then on. Child events carry the PARENT's
      // id and never mint a child's own liveness.
      const sid = event.session_id;
      if (
        emitStages &&
        typeof sid === 'string' &&
        world.sessions.has(sid) &&
        world.sessions.get(sid)?.parentSessionId === null
      ) {
        live.add(sid);
      }
    },
    isSessionLive: (id) => live.has(id),
    isAdoptableDir: (cwd) => watchAll || trackedDirs.has(cwd),
  };

  const deps: HermesScannerDeps = {
    home: () => '/fake/home',
    openStore: () => makeStore(world),
    readLeases: () => world.leases,
    pidAlive: (pid) => !world.deadPids.has(pid),
    nowMs: () => Date.now(),
    intervalMs,
  };

  const scanner = createHermesSessionScanner(ctx, deps);
  return {
    emitted,
    live,
    trackedDirs,
    scanner,
    setWatchAll: (value: boolean) => {
      watchAll = value;
    },
    /** Fire one interval (or `times` of them, for the grace-window tests). */
    tick: (times = 1) => {
      vi.advanceTimersByTime(intervalMs * times);
    },
  };
}

type Harness = ReturnType<typeof buildScanner>;

function eventsOf(emitted: Record<string, unknown>[], name: string): Record<string, unknown>[] {
  return emitted.filter((e) => e.hook_event_name === name);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hermesSessionScanner adoption', () => {
  it('adopts a live, leased, policy-approved session with the wire two-beat', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();

    const starts = eventsOf(h.emitted, 'on_session_start');
    const ends = eventsOf(h.emitted, 'on_session_end');
    expect(starts).toHaveLength(1);
    expect(starts[0].session_id).toBe('s1');
    expect(starts[0].cwd).toBe('/work/one');
    expect((starts[0].extra as Record<string, unknown>).platform).toBe('cli');
    expect(ends).toHaveLength(1); // the confirmation beat; adoption lands idle
    expect(h.live.has('s1')).toBe(true);
  });

  it('retries a refused birth every tick instead of sticking observed', () => {
    // A birth emit is a REQUEST, not an acceptance: if the office refuses to
    // stage it (the provider's path-less sessionStart died at the staging
    // gate — the cwd-NULL desktop defect), the watch must NOT settle into
    // observed. Marking observed on a refused attempt made such sessions
    // invisible forever: the confirm beat never fired, the retry never came.
    const world = emptyWorld();
    world.sessions.set('s1', {
      ...session({ id: 's1', source: 'desktop', cwd: '' }),
      endedAt: null,
    });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'desktop' }];
    const h = buildScanner(world, [], 1, { emitStages: false });
    h.setWatchAll(true);
    h.scanner.start(); // immediate tick
    h.tick(2);
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(3); // retried each tick
    expect(eventsOf(h.emitted, 'on_session_end')).toHaveLength(0); // never confirmed a refusal
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(0); // and never reaped
  });

  it('never adopts twice, and stays quiet on idle ticks', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    const afterAdoption = h.emitted.length;
    h.tick();
    h.tick();
    expect(h.emitted).toHaveLength(afterAdoption);
  });

  it('requires a live lease to adopt — absence of proof never reaps either', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(0);
  });

  it('untracked directory without Watch All Sessions: no adoption; with it on: adopted', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);

    h.setWatchAll(true);
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(1);
  });

  it('skips unattended and transient sources; attended surfaces adopt', () => {
    const world = emptyWorld();
    for (const source of ['cron', 'batch', 'oneshot', 'unknown']) {
      world.sessions.set(`s-${source}`, {
        ...session({ id: `s-${source}`, source }),
        endedAt: null,
      });
      world.leases.push({ sessionId: `s-${source}`, pid: 200, surface: 'cli' });
    }
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);

    // desktop is attended even without a cwd; the Directory policy covers it
    // exactly like the hook path does (Watch All on here).
    world.sessions.set('desktop-1', {
      ...session({ id: 'desktop-1', source: 'desktop', cwd: '' }),
      endedAt: null,
    });
    world.leases.push({ sessionId: 'desktop-1', pid: 201, surface: 'desktop' });
    h.setWatchAll(true);
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(1);
  });

  it('stands down forever on a session hooks already drive (dismissal must not resurrect it)', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world, ['s1']); // hooks got there first
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);

    h.live.delete('s1'); // user dismissed the character
    h.tick();
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);
  });
});

describe('hermesSessionScanner liveness (tier-2 ghost reaping)', () => {
  it('reaps once when the lease pid dies — the SIGKILL no hook can announce', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();

    world.deadPids.add(111);
    h.tick();
    const finalizes = eventsOf(h.emitted, 'on_session_finalize');
    expect(finalizes).toHaveLength(1);
    expect((finalizes[0].extra as Record<string, unknown>).platform).toBe(
      HERMES_SCANNER_REAP_REASON,
    );

    h.tick();
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1); // never twice
  });

  it('reaps hook-driven sessions too — the scanner is their only funeral', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world, ['s1']);
    h.scanner.start();
    h.tick();
    world.deadPids.add(111);
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1);
  });

  it('ended_at appearing without any goodbye reaps as well', () => {
    const world = emptyWorld();
    const s1: FakeSession = { ...session({ id: 's1' }), endedAt: null };
    world.sessions.set('s1', s1);
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    s1.endedAt = Date.now();
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1);
  });

  it('a vanished row (deleted session) is death, not an error', () => {
    const world = emptyWorld();
    const s1: FakeSession = { ...session({ id: 's1' }), endedAt: null, missing: false };
    world.sessions.set('s1', s1);
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    s1.missing = true;
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1);
  });

  // ── The pruned-lease ghost: no lease row at all ───────────────────────
  // A hard-killed process leaves its LIVE store row behind, and Hermes' own
  // registry janitor drops the lease entry when it next writes the file — so
  // the desk can be holding a character whose only remaining trace is a row
  // nothing owns anymore. Observed over a 5 s tick, with the 60 s registration
  // grace and the 90 s orphan grace from constants.ts.

  const ORPHAN_TICKS = 35; // 175 s: past both graces

  it('reaps a desk-held session whose lease vanished entirely', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    world.leases = []; // pruned by the store's janitor; the row stayed live
    const h = buildScanner(world, ['s1'], 5_000);
    h.scanner.start();
    h.tick(10); // 50 s: inside the registration grace, nothing judged yet
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(0);

    h.tick(ORPHAN_TICKS);
    const finalizes = eventsOf(h.emitted, 'on_session_finalize');
    expect(finalizes).toHaveLength(1);
    expect((finalizes[0].extra as Record<string, unknown>).platform).toBe(
      HERMES_SCANNER_REAP_REASON,
    );

    h.tick(10); // and never a second time
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1);
  });

  it('a lease that comes back cancels the orphan verdict', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    const h = buildScanner(world, ['s1'], 5_000);
    h.scanner.start();
    h.tick(20); // clock running (lease absent)
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }]; // re-acquired
    h.tick(ORPHAN_TICKS + 20);
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(0);
  });

  it('says nothing forever about an orphan the desk does not hold', () => {
    // The store is full of sessions that ended long before finalize was
    // written (130 on a real machine). They are not characters: silence.
    const world = emptyWorld();
    world.sessions.set('s1', { ...session({ id: 's1' }), endedAt: null });
    const h = buildScanner(world, [], 5_000);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    h.tick(80);
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(0);
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(0);
  });
});

describe('hermesSessionScanner message replay (the parseTranscriptLine twin)', () => {
  it('replays calls, results, and the final answer from a young session', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...young({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    world.messages.set('s1', [
      message({
        id: 1,
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'terminal', args: { command: 'ls', secret: 'x' } }],
      }),
      message({ id: 2, role: 'tool', toolCallId: 'c1' }),
      message({ id: 3, role: 'assistant', hasText: true }),
    ]);
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start(); // tick 1: adoption only (tickRoot returns before replay)
    h.tick(); // tick 2: cursor 0 → the whole tail replays

    const pres = eventsOf(h.emitted, 'pre_tool_call');
    expect(pres).toHaveLength(1);
    expect(pres[0].tool_name).toBe('terminal');
    expect((pres[0].extra as Record<string, unknown>).tool_call_id).toBe('c1');
    // Status fields only — the full argument blob never crosses into events.
    expect(pres[0].tool_input).toEqual({ command: 'ls' });
    expect(eventsOf(h.emitted, 'post_tool_call')).toHaveLength(1);
    // 1 confirmation (adoption) + 1 from the final answer:
    expect(eventsOf(h.emitted, 'on_session_end')).toHaveLength(2);
  });

  it('a session that predates the server starts its cursor at the tail (no history flash)', () => {
    const world = emptyWorld();
    world.sessions.set('s1', {
      ...session({ id: 's1', startedAtMs: Date.now() - 86_400_000, lastActivityMs: Date.now() }),
      endedAt: null,
    });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    world.messages.set('s1', [
      message({ id: 10, role: 'assistant', toolCalls: [{ id: 'c1', name: 'web_search' }] }),
    ]);
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'pre_tool_call')).toHaveLength(0);

    // Live rows past the tail DO animate.
    world.messages
      .get('s1')!
      .push(message({ id: 11, role: 'assistant', toolCalls: [{ id: 'c2', name: 'terminal' }] }));
    h.tick();
    const pres = eventsOf(h.emitted, 'pre_tool_call');
    expect(pres).toHaveLength(1);
    expect((pres[0].extra as Record<string, unknown>).tool_call_id).toBe('c2');
  });

  it('tool results only close calls the replay itself opened', () => {
    const world = emptyWorld();
    world.sessions.set('s1', { ...young({ id: 's1' }), endedAt: null });
    world.leases = [{ sessionId: 's1', pid: 111, surface: 'cli' }];
    world.messages.set('s1', [message({ id: 1, role: 'tool', toolCallId: 'ghost-call' })]);
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'post_tool_call')).toHaveLength(0);
  });
});

describe('hermesSessionScanner sub-agent correlation', () => {
  function withParent(): { world: FakeWorld; h: Harness } {
    const world = emptyWorld();
    world.sessions.set('parent', { ...young({ id: 'parent' }), endedAt: null });
    world.leases = [{ sessionId: 'parent', pid: 300, surface: 'cli' }];
    const h = buildScanner(world);
    h.trackedDirs.add('/work/one');
    h.scanner.start();
    return { world, h };
  }

  it('renders a live child under an on-desk parent as a subagent_session_start', () => {
    const { world, h } = withParent();
    world.sessions.set('kid', {
      ...session({ id: 'kid', parentSessionId: 'parent', title: 'Subagent: fix the flake' }),
      endedAt: null,
    });
    h.tick();
    const starts = eventsOf(h.emitted, 'subagent_session_start');
    expect(starts).toHaveLength(1);
    expect(starts[0].session_id).toBe('parent'); // routed to the PARENT
    expect(starts[0].subagent_session_id).toBe('kid');
    expect(starts[0].subagent_title).toBe('Subagent: fix the flake');
  });

  it('waits for the parent instead of burning the birth event; emits once after', () => {
    const world = emptyWorld();
    world.sessions.set('kid', {
      ...session({ id: 'kid', parentSessionId: 'nobody' }),
      endedAt: null,
    });
    const h = buildScanner(world);
    h.scanner.start();
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_start')).toHaveLength(0);

    // Parent appears live: the child birth lands now — same tick, because
    // roots are processed before children — and exactly once after that.
    world.sessions.set('nobody', { ...young({ id: 'nobody' }), endedAt: null });
    world.leases = [{ sessionId: 'nobody', pid: 300, surface: 'cli' }];
    h.setWatchAll(true);
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_start')).toHaveLength(1);
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_start')).toHaveLength(1);
  });

  it('child retirement lands subagent_session_end only while the parent holds the desk', () => {
    const { world, h } = withParent();
    const kid: FakeSession = {
      ...session({ id: 'kid', parentSessionId: 'parent' }),
      endedAt: null,
    };
    world.sessions.set('kid', kid);
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_start')).toHaveLength(1);

    kid.endedAt = Date.now();
    h.tick();
    const ends = eventsOf(h.emitted, 'subagent_session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].session_id).toBe('parent');
    expect(ends[0].subagent_session_id).toBe('kid');
  });

  it('parent death takes the children with it silently (their character dies with the lead)', () => {
    const { world, h } = withParent();
    world.sessions.set('kid', {
      ...session({ id: 'kid', parentSessionId: 'parent' }),
      endedAt: null,
    });
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_start')).toHaveLength(1);

    world.deadPids.add(300); // the whole process tree is gone
    h.tick();
    expect(eventsOf(h.emitted, 'subagent_session_end')).toHaveLength(0);
    expect(eventsOf(h.emitted, 'on_session_finalize')).toHaveLength(1);
  });

  it('children are never adopted as full characters', () => {
    const { world, h } = withParent();
    world.sessions.set('kid', {
      ...session({ id: 'kid', parentSessionId: 'parent' }),
      endedAt: null,
    });
    h.tick();
    expect(eventsOf(h.emitted, 'on_session_start')).toHaveLength(1); // parent only
  });
});

describe('subagentStatusLabel', () => {
  it('trims the Subagent prefix, bounds the length, and falls back for empties', () => {
    expect(subagentStatusLabel('Subagent: fix the flaky test')).toBe('fix the flaky test');
    expect(subagentStatusLabel('   ')).toBe('delegate_task');
    expect(subagentStatusLabel('no prefix title')).toBe('no prefix title');
    const long = subagentStatusLabel(`Subagent: ${'x'.repeat(200)}`);
    expect(long).toHaveLength(61); // 60 chars + the ellipsis
    expect(long.endsWith('\u2026')).toBe(true);
  });
});
