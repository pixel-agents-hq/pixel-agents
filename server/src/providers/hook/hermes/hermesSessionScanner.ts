/**
 * hermesSessionScanner — the session-store twin of the JSONL heuristic mode.
 *
 * It polls Hermes' on-disk artifacts (hermesSessionStore) and feeds
 * TRANSITIONS — never states — into the ordinary hook pipeline as raw
 * wire-shaped envelopes. Everything it emits passes through this provider's
 * normalizeHookEvent and the shared HookEventHandler, so adoption, buffering,
 * session→agent routing, and rendering are exactly the hook-delivery paths;
 * a scanner event can never introduce a second office.
 *
 * What it delivers, in order of importance:
 *
 *  1. LIVENESS (tier-2 item 5). A push-only provider has no signal after a
 *     SIGKILL/app-quit: nothing fires on_session_finalize and the character
 *     ghosts until a server restart. The store proves death two ways —
 *     `ended_at` appearing on the row, or the session's LEASE pid vanishing
 *     from the OS. Either one reaps the character. Absence of proof never
 *     does: a missing lease (older Hermes, other profile's registry) is
 *     "unknown", not "dead", so nothing gets reaped on speculation.
 *
 *  2. HOOK-LESS ADOPTION (tier-2 item 3). A live session (lease pid alive),
 *     from an attended source, in a policy-approved directory is adopted
 *     with a synthetic on_session_start + on_session_end confirmation —
 *     the same two-beat the wire plays — then activity is REPLAYED from
 *     `messages`: assistant tool_calls rows → pre_tool_call, tool result
 *     rows → post_tool_call, a final text answer → on_session_end. Only
 *     rows NEWER than the session's cursor are replayed, and a session that
 *     predates the server starts its cursor at the tail (Claude's adoption
 *     heuristic: never flash an old session's history). If hooks delivered
 *     first, the session is already live in the router and the scanner
 *     permanently stands down its rendering (it keeps only liveness) — no
 *     double bubbles.
 *
 *  3. SUB-AGENT CORRELATION (tier-2 item 4). delegate_task children are
 *     sessions with parent_session_id set — a mapping the wire ENVELOPE
 *     does not carry (the builder resolves session_id and drops
 *     parent_session_id from `extra`). The store does carry it, so the
 *     scanner is the only place the office can learn "this child belongs to
 *     that parent". Each live child under a parent that is on the desk
 *     becomes a `subagent_session_start` (scanner-only wire name, routed to
 *     the PARENT's session id) → the Subtask sub-character machinery; its
 *     end is a `subagent_session_end`. Children are never adopted as full
 *     characters (the wire already drops their sessionStart via
 *     HERMES_SILENT_PLATFORMS and this scanner never emits their adoption).
 *
 * The scanner is READ-ONLY and never spawns anything; a broken store,
 * missing database, or unreadable registry is indistinguishable from "no
 * sessions", which is exactly how every other fallback here treats absence.
 */

import type { SessionScanner, SessionScannerContext } from '../../../../../core/src/provider.js';
import {
  HERMES_SCANNER_INTERVAL_MS,
  HERMES_SCANNER_LEASE_REGISTER_GRACE_MS,
  HERMES_SCANNER_ORPHAN_GRACE_MS,
  HERMES_SCANNER_REAP_REASON,
  HERMES_SCANNER_REAP_TOMBSTONES,
  HERMES_SCANNER_REPLAY_LIMIT,
  HERMES_SCANNER_SUBAGENT_END_EVENT,
  HERMES_SCANNER_SUBAGENT_START_EVENT,
  HERMES_SCANNER_SUBAGENT_TITLE_MAX,
  HERMES_SUBAGENT_TITLE_PREFIX,
  isSilentSource,
} from './constants.js';
import { getHermesHome } from './hermesHookInstaller.js';
import {
  type HermesLease,
  type HermesSessionRecord,
  type HermesSessionStore,
  isHermesPidAlive,
  openHermesStore,
  readHermesLeases,
} from './hermesSessionStore.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** Injectable world access — the tests drive tick() against a temp
 *  state.db + fake lease registry without touching the real home or pids. */
export interface HermesScannerDeps {
  home(): string;
  openStore(home: string): HermesSessionStore | null;
  readLeases(home: string): HermesLease[];
  pidAlive(pid: number): boolean;
  nowMs(): number;
  intervalMs: number;
}

export const defaultHermesScannerDeps: HermesScannerDeps = {
  home: getHermesHome,
  openStore: openHermesStore,
  readLeases: readHermesLeases,
  pidAlive: isHermesPidAlive,
  nowMs: () => Date.now(),
  intervalMs: HERMES_SCANNER_INTERVAL_MS,
};

/** Scanner bookkeeping per session id (roots and children share the map;
 *  the kind is fixed by the row's parent_session_id). */
interface SessionWatch {
  /** 'child' when the row carries parent_session_id. */
  kind: 'root' | 'child';
  /** We already emitted this session's birth event (adoption or
   *  subagent_start) and must not emit it again. */
  observed: boolean;
  /** A root that hooks/the launcher were driving BEFORE we ever saw it: the
   *  scanner owns its liveness but must NEVER render it. Sticky — a
   *  dismissed character is not something the scanner re-adopts. */
  externallyDriven: boolean;
  /** Highest `messages.id` already replayed. -1 = not initialized yet. */
  cursor: number;
  /** Tool calls replayed as pre_tool_call whose post_tool_call has not been
   *  seen yet (id → name). Bounds duplicate 'current' clears. */
  pendingCalls: Map<string, string>;
  /** Child rows remember their parent for the end event's routing. */
  parentId?: string;
  /** Tick time at which this session's lease was first seen ABSENT (null =
   *  present, or not judged yet). Drives the orphan reaping grace. */
  leaseAbsentSince: number | null;
}

/** Keys of tool arguments the office's status renderer reads (see
 *  formatToolStatus + the background flag). Replaying FULL arguments would
 *  put file contents into event objects for zero display gain, so only
 *  these shallow scalar/array fields cross. */
const STATUS_INPUT_KEYS = [
  'path',
  'command',
  'urls',
  'target',
  'background',
  'goal',
  'description',
  'task',
] as const;

function projectStatusInput(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const key of STATUS_INPUT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value;
    }
  }
  return out;
}

/** 'Subagent: add the --session-id flag…' → the goal text, bounded. */
export function subagentStatusLabel(title: string): string {
  const goal = title.startsWith(HERMES_SUBAGENT_TITLE_PREFIX)
    ? title.slice(HERMES_SUBAGENT_TITLE_PREFIX.length)
    : title;
  const trimmed = goal.trim();
  if (!trimmed) return 'delegate_task';
  return trimmed.length > HERMES_SCANNER_SUBAGENT_TITLE_MAX
    ? trimmed.slice(0, HERMES_SCANNER_SUBAGENT_TITLE_MAX) + '\u2026'
    : trimmed;
}

export function createHermesSessionScanner(
  ctx: SessionScannerContext,
  deps: HermesScannerDeps = defaultHermesScannerDeps,
): SessionScanner {
  const watches = new Map<string, SessionWatch>();
  /** Ids whose death we already announced — see HERMES_SCANNER_REAP_TOMBSTONES.
   *  Insertion-ordered, so evicting the first entry ages out the oldest. */
  const reapedIds = new Set<string>();
  const serverStartMs = deps.nowMs();
  let store: HermesSessionStore | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function markReaped(id: string): void {
    reapedIds.add(id);
    if (reapedIds.size > HERMES_SCANNER_REAP_TOMBSTONES) {
      const oldest = reapedIds.values().next().value;
      if (oldest !== undefined) reapedIds.delete(oldest);
    }
  }

  /** Fresh lease pid per session id (first entry wins: duplicates are a
   *  race between a release/re-acquire and either pid proves liveness). */
  function leasePids(): Map<string, number> {
    const bySession = new Map<string, number>();
    for (const lease of deps.readLeases(deps.home())) {
      if (!bySession.has(lease.sessionId)) bySession.set(lease.sessionId, lease.pid);
    }
    return bySession;
  }

  function watchOf(id: string, kind: SessionWatch['kind'], parentId?: string): SessionWatch {
    let watch = watches.get(id);
    if (!watch) {
      watch = {
        kind,
        observed: false,
        externallyDriven: false,
        cursor: -1,
        pendingCalls: new Map(),
        parentId,
        leaseAbsentSince: null,
      };
      watches.set(id, watch);
    }
    return watch;
  }

  /** Positive-death proof only: ended_at appeared, the row is gone, or the
   *  lease pid is dead. Returns 'none' when liveness cannot be judged. */
  type Verdict = 'alive' | 'dead' | 'unknown';
  function verdictFor(sessionId: string, leaseBySession: Map<string, number>): Verdict {
    const ended = store?.endedAtOf(sessionId);
    if (ended !== null) return 'dead'; // number (ended) or undefined (row gone)
    const pid = leaseBySession.get(sessionId);
    if (pid === undefined) return 'unknown'; // no lease: never reap on speculation
    return deps.pidAlive(pid) ? 'alive' : 'dead';
  }

  function adoptEligible(row: HermesSessionRecord, leaseBySession: Map<string, number>): boolean {
    if (isSilentSource(row.source)) return false;
    const pid = leaseBySession.get(row.id);
    if (pid === undefined || !deps.pidAlive(pid)) return false;
    return ctx.isAdoptableDir(row.cwd);
  }

  function replayActivity(row: HermesSessionRecord, watch: SessionWatch): void {
    if (!store) return;
    const messages = store.listMessagesAfter(row.id, watch.cursor, HERMES_SCANNER_REPLAY_LIMIT);
    for (const message of messages) {
      watch.cursor = message.id;
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) {
          if (watch.pendingCalls.has(call.id)) continue;
          watch.pendingCalls.set(call.id, call.name);
          ctx.emit({
            hook_event_name: 'pre_tool_call',
            session_id: row.id,
            tool_name: call.name,
            tool_input: projectStatusInput(call.args),
            extra: { tool_call_id: call.id },
          });
        }
        // No calls + text = the turn's final answer → Done. (An assistant row
        // without calls and without text is mid-stream reasoning: stay quiet.)
        if (message.toolCalls.length === 0 && message.hasText) {
          ctx.emit({ hook_event_name: 'on_session_end', session_id: row.id });
          watch.pendingCalls.clear();
        }
      } else if (
        message.role === 'tool' &&
        message.toolCallId &&
        watch.pendingCalls.delete(message.toolCallId)
      ) {
        ctx.emit({ hook_event_name: 'post_tool_call', session_id: row.id });
      }
    }
  }

  function tickRoot(row: HermesSessionRecord, leaseBySession: Map<string, number>): void {
    const watch = watchOf(row.id, 'root');
    const verdict = verdictFor(row.id, leaseBySession);
    const liveDriven = ctx.isSessionLive(row.id);
    const now = deps.nowMs();
    // A lease that came back cancels any orphan verdict outright.
    if (leaseBySession.has(row.id)) watch.leaseAbsentSince = null;

    if (verdict === 'dead') {
      watches.delete(row.id);
      // Reap only if the office could still hold a character for it — ours
      // (observed) or a hook/launcher-driven one (live right now) — and only
      // once ever (the row of a killed session stays live in the store).
      if ((watch.observed || liveDriven) && !reapedIds.has(row.id)) {
        emitReap(row.id);
        markReaped(row.id);
      }
      return;
    }

    if (verdict === 'unknown' && watch.leaseAbsentSince === null) {
      // No lease row. A live Hermes process keeps one, and Hermes' own janitor
      // prunes entries whose pid is gone, so for a session the desk still
      // holds this IS death by the store's own standard - but not before the
      // registry had a chance to be written (young rows) and not on the first
      // tick we happen to catch mid-write (the grace below).
      if (
        now - Math.max(row.startedAtMs, serverStartMs) >=
        HERMES_SCANNER_LEASE_REGISTER_GRACE_MS
      ) {
        watch.leaseAbsentSince = now;
      }
    } else if (
      verdict === 'unknown' &&
      now - watch.leaseAbsentSince! >= HERMES_SCANNER_ORPHAN_GRACE_MS &&
      (watch.observed || liveDriven) &&
      !reapedIds.has(row.id)
    ) {
      watches.delete(row.id);
      emitReap(row.id);
      markReaped(row.id);
      return;
    }

    if (!watch.observed) {
      if (liveDriven || watch.externallyDriven) {
        // Hooks (or the launcher) got here first: they own rendering. We stay
        // a liveness-only observer even if that driver later goes quiet —
        // re-adopting a session someone just DISMISSED would resurrect an
        // intentionally removed character, so the flag is sticky.
        watch.externallyDriven = true;
        return;
      }
      if (!adoptEligible(row, leaseBySession)) return;
      ctx.emit({
        hook_event_name: 'on_session_start',
        session_id: row.id,
        cwd: row.cwd,
        extra: { platform: row.source },
      });
      // The emit is a REQUEST, not an acceptance: the office stages the birth
      // synchronously (router pending counts as live), so isSessionLive right
      // after the emit is the receipt that the session is in the pipeline. A
      // refused birth must stay un-observed and be RETRIED next tick —
      // marking observed on a refused attempt made the session invisible
      // forever with no trace (the desktop-gateway cwd-NULL defect).
      if (!ctx.isSessionLive(row.id)) return;
      watch.observed = true;
      watch.cursor = row.startedAtMs < serverStartMs ? (store?.latestMessageId(row.id) ?? 0) : 0;
      // The wire's confirmation beat: sessionStart alone only stages the
      // pending session — a following non-start event creates the character.
      // Adopting idle is honest: anything still running replays within a tick.
      ctx.emit({ hook_event_name: 'on_session_end', session_id: row.id });
      return;
    }

    // Ours, and present on the desk: replay deltas. (Dismissed or otherwise
    // gone from the router → isSessionLive false → replay stops; the desk is
    // no longer listening, and the watch stays for liveness cleanup.)
    if (liveDriven && !watch.externallyDriven) replayActivity(row, watch);
  }

  function tickChild(
    row: HermesSessionRecord,
    liveById: Map<string, HermesSessionRecord>,
    leaseBySession: Map<string, number>,
  ): void {
    const parentId = row.parentSessionId;
    if (!parentId) return;
    const watch = watchOf(row.id, 'child', parentId);

    const parentLive = verdictFor(parentId, leaseBySession) === 'alive';
    const parentKnown = liveById.has(parentId);
    const childDead = store !== null && store.endedAtOf(row.id) !== null;
    if (childDead || !parentLive || !parentKnown) {
      watches.delete(row.id);
      if (watch.observed && childDead && !reapedIds.has(row.id) && ctx.isSessionLive(parentId)) {
        ctx.emit({
          hook_event_name: HERMES_SCANNER_SUBAGENT_END_EVENT,
          session_id: parentId,
          subagent_session_id: row.id,
        });
        markReaped(row.id);
      }
      return;
    }

    if (watch.observed) return;
    // The parent must EXIST on the desk (registered or pending confirmation)
    // or have been scanner-adopted this tick; sub-characters render near the
    // parent, and an event for a parent-less session would only buffer to
    // expiry. Roots are processed before children, so same-tick adoption
    // works.
    const parentOnDesk = ctx.isSessionLive(parentId) || (watches.get(parentId)?.observed ?? false);
    if (!parentOnDesk) return;
    if (isSilentSource(row.source)) return;
    ctx.emit({
      hook_event_name: HERMES_SCANNER_SUBAGENT_START_EVENT,
      session_id: parentId,
      subagent_session_id: row.id,
      subagent_title: row.title,
      cwd: row.cwd,
    });
    watch.observed = true;
  }

  function tickInner(): void {
    if (!store) {
      store = deps.openStore(deps.home());
      if (!store) return;
    }
    const live = store.listLiveSessions();
    const liveById = new Map(live.map((row) => [row.id, row] as const));
    const leaseBySession = leasePids();
    // Roots first: a parent adopted this tick must exist before its children
    // reference it (their events route to the parent's session id).
    for (const row of live) {
      if (row.parentSessionId === null) tickRoot(row, leaseBySession);
    }
    for (const row of live) {
      if (row.parentSessionId !== null) tickChild(row, liveById, leaseBySession);
    }
    reapDepartures(liveById);
    // Never let bookkeeping outlive the desk: drop entries that were never
    // observed and are not live (rows that appeared and vanished between
    // ticks, cron runs, sessions of other homes).
    if (watches.size > 200) {
      for (const [id, watch] of watches) {
        if (!watch.observed && !ctx.isSessionLive(id)) watches.delete(id);
      }
    }
  }

  /**
   * The disappeared-row sweep. `listLiveSessions()` only returns rows that are
   * live RIGHT NOW — so the ordinary death of a session (ended_at set, or the
   * row deleted) removes it from iteration, and a reap built on iterating live
   * rows would miss every gracefully-closed-but-never-announced session.
   * Anything we watched that is gone from the live set therefore gets its
   * death re-confirmed against the store: a row still present with
   * ended_at NULL merely HID (sidebar hide keeps running — leave the
   * character alone); ended or deleted is death, reaped once.
   */
  function reapDepartures(liveById: Map<string, HermesSessionRecord>): void {
    if (!store) return;
    for (const [id, watch] of [...watches]) {
      if (liveById.has(id)) continue;
      if (watch.kind !== 'root' && watch.parentId && !liveById.has(watch.parentId)) {
        // Parent left first: the sub-character already died with it.
        watches.delete(id);
        continue;
      }
      const ended = store.endedAtOf(id);
      if (ended === null) continue; // still alive, just hidden
      watches.delete(id);
      if (reapedIds.has(id)) continue; // goodbye already said
      if (!watch.observed) {
        // We never rendered this one: bookkeeping only. (A hook-driven
        // session the hooks failed to say goodbye to still needs retiring if
        // the desk is holding it.)
        if (ctx.isSessionLive(id) && watch.externallyDriven) {
          emitReap(id);
          markReaped(id);
        }
        continue;
      }
      if (watch.kind === 'child' && watch.parentId) {
        if (ctx.isSessionLive(watch.parentId)) {
          ctx.emit({
            hook_event_name: HERMES_SCANNER_SUBAGENT_END_EVENT,
            session_id: watch.parentId,
            subagent_session_id: id,
          });
          markReaped(id);
        }
      } else {
        emitReap(id);
        markReaped(id);
      }
    }
  }

  function emitReap(id: string): void {
    ctx.emit({
      hook_event_name: 'on_session_finalize',
      session_id: id,
      extra: { platform: HERMES_SCANNER_REAP_REASON },
    });
  }

  function tick(): void {
    try {
      tickInner();
    } catch (err) {
      // Any query throw: drop the handle and re-open next tick. The office
      // must never crash on a store we only borrow.
      if (debug) console.log('[Pixel Agents] Hermes scanner tick failed:', err);
      try {
        store?.close();
      } catch {
        /* already dead */
      }
      store = null;
    }
  }

  return {
    start(): void {
      if (timer) return;
      tick(); // immediate first pass: the desk should not wait one interval
      timer = setInterval(tick, deps.intervalMs);
      timer.unref?.(); // the poller must not hold the process open by itself
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      watches.clear();
      reapedIds.clear();
      try {
        store?.close();
      } catch {
        /* already dead */
      }
      store = null;
    },
  };
}
