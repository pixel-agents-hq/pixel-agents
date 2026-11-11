/**
 * Task dispatch: a Workspace's curator hands a task to another running agent of
 * the same Workspace (MCP tool `dispatch_task`, standalone only). The server
 * writes the task into the target's PTY iff every rule below holds.
 *
 * WHAT THIS IS NOT: an isolation boundary. Like capabilities.ts, it guards
 * against a process-following agent MISUSING dispatch -- the curator writing
 * into an agent that is busy, skips permissions, holds more permission roles,
 * belongs to another Workspace, or is being typed into by the operator. Every
 * agent runs as the operator's OS user and can type into any terminal through
 * /terminal, read other agents' capabilities, and so on; nothing here stops a
 * hostile local process.
 *
 * Shape of a dispatch (dispatch()):
 * 1. authenticate: verify() the capability; the caller's identity and Workspace
 *    come ONLY from its claims, never from the request body;
 * 2. validate the task text (taskInput.ts) -- reject, never strip;
 * 3. flush the target's headless mirror (PtySession.afterParsed), so every
 *    chunk the target printed before now is parsed;
 * 4. INSIDE that callback, as one synchronous block with no await: re-run
 *    verify(), every rule, read the mirror's modes, and write. Nothing can
 *    change between the last check and the write.
 *
 * Rules (evaluateRules): 1 caller's Workspace is not the default and the caller
 * is its CURRENT curator; 2 target is a live, non-external, non-stopped,
 * non-teammate PTY agent of the same Workspace and not the caller; 3 no
 * bypass anywhere (the host setting now, the caller's or the target's launch)
 * and the target's permission roles are a subset of the caller's; 4 the
 * target's write guard is active; 5 the target is idle (a turn completed in
 * this PTY session, waiting, no permission prompt, no active tool), not in the
 * alternate screen, with bracketed paste on; 6 no operator input into the
 * target within the quiet period and no earlier dispatch still in flight; 7
 * per-caller and per-target rate limits.
 *
 * Every refusal answers the same fixed message; the reason is in the audit
 * line only. The audit line never carries the task or the token.
 */

import * as crypto from 'crypto';

import { DEFAULT_WORKSPACE_ID } from '../../../core/src/constants.js';
import type { AgentStateStore, TurnActivityKind } from '../agentStateStore.js';
import type { CapabilityClaims } from '../capabilities.js';
import { workspaceKey } from '../capabilities.js';
import {
  TASK_DISPATCH_FLUSH_DEADLINE_MS,
  TASK_DISPATCH_OPERATOR_QUIET_MS,
  TASK_DISPATCH_RATE_MAX_PER_CALLER,
  TASK_DISPATCH_RATE_MAX_PER_TARGET,
  TASK_DISPATCH_RATE_WINDOW_MS,
} from '../constants.js';
import type { TerminalModes } from '../terminal/ptySessionManager.js';
import type { PermissionRoles } from '../writeGuard/permissionRoles.js';
import { frameTaskInput, validateTaskText } from './taskInput.js';

/** The part of a PtySession dispatch touches. */
export interface DispatchPtySession {
  readonly hasExited: boolean;
  afterParsed(callback: () => void): void;
  terminalModes(): TerminalModes;
  write(data: string): void;
}

export interface TaskDispatcherDeps {
  /** The MAIN store: shadow (sub-agent) agents are never in it. */
  store: AgentStateStore;
  ptyManager: {
    get(agentId: number): DispatchPtySession | undefined;
    has(agentId: number): boolean;
  };
  capabilities: { verify(presented: unknown): CapabilityClaims | null };
  curators: { curatorOf(workspaceId: string | undefined): number | null };
  /** Rule 4: the target's write guard is active (GuardStatusReporter). */
  guard: { isGuardActive(agentId: number): boolean };
  operatorInput: { lastInputAtFor(agentId: number): number | undefined };
  /** The host-wide bypass setting as it is NOW (read on every evaluation). */
  hostBypassEnabled: () => boolean;
  now?: () => number;
  /** Where the audit line goes (console.log in production). */
  audit?: (line: string) => void;
  flushDeadlineMs?: number;
}

export type DispatchResult =
  { ok: true; targetAgentId: number; displayName?: string; directoryName?: string } | { ok: false };

/** Why a dispatch was refused: audit log only, never returned to the caller. */
export type DispatchDenial =
  | 'unauthenticated'
  | 'invalid_arguments'
  | 'invalid_task'
  | 'flush_timeout'
  | 'default_workspace'
  | 'not_curator'
  | 'caller_missing'
  | 'self'
  | 'target_missing'
  | 'cross_workspace'
  | 'external'
  | 'stopped'
  | 'no_pty'
  | 'teammate'
  | 'bypass_host'
  | 'bypass_caller'
  | 'bypass_target'
  | 'roles'
  | 'guard_inactive'
  | 'no_turn_completed'
  | 'busy'
  | 'alternate_screen'
  | 'no_bracketed_paste'
  | 'operator_typing'
  | 'in_flight'
  | 'rate_caller'
  | 'rate_target';

interface ParsedArguments {
  targetAgentId: number;
  task: unknown;
}

/** Turn-activity kinds that prove the target took up new input. A turn end
 *  alone does not: a duplicate turn end of the PREVIOUS turn (hooks Stop,
 *  then the JSONL turn_duration) can arrive after the write, and a tool-result
 *  record can trail a Stop the same way. */
const LOCK_RELEASING_ACTIVITY: ReadonlySet<TurnActivityKind> = new Set(['userPrompt', 'toolStart']);

function parseArguments(args: unknown): ParsedArguments | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const target = record.targetAgentId;
  if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) return null;
  return { targetAgentId: target, task: record.task };
}

/** Null caller roles allow everything, so may target anyone (null included);
 *  a restricted caller may only target a subset of its own roles. */
export function rolesWithin(caller: PermissionRoles, target: PermissionRoles): boolean {
  if (caller === null) return true;
  if (target === null) return false;
  return target.every((role) => caller.includes(role));
}

export class TaskDispatcher {
  private readonly deps: TaskDispatcherDeps;
  private readonly now: () => number;
  private readonly audit: (line: string) => void;
  /** Targets written to whose session has not visibly taken up new input yet. */
  private readonly inFlight = new Set<number>();
  /** caller id -> timestamps of evaluated attempts; target id -> of writes. */
  private readonly callerAttempts = new Map<number, number[]>();
  private readonly targetWrites = new Map<number, number[]>();
  private readonly unsubscribers: (() => void)[] = [];

  constructor(deps: TaskDispatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.audit = deps.audit ?? ((line) => console.log(line));
    const { store } = deps;
    const onActivity = (id: number, kind: TurnActivityKind): void => {
      if (LOCK_RELEASING_ACTIVITY.has(kind)) this.inFlight.delete(id);
    };
    const onRemoved = (id: number): void => {
      this.inFlight.delete(id);
    };
    const onCleared = (ids: number[]): void => ids.forEach(onRemoved);
    store.on('agentTurnActivity', onActivity);
    store.on('agentRemoved', onRemoved);
    store.on('agentsCleared', onCleared);
    this.unsubscribers.push(() => {
      store.off('agentTurnActivity', onActivity);
      store.off('agentRemoved', onRemoved);
      store.off('agentsCleared', onCleared);
    });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /** Whether a write to this target is still in flight (tests, diagnostics). */
  isInFlight(targetAgentId: number): boolean {
    return this.inFlight.has(targetAgentId);
  }

  /**
   * Dispatch a task. `authorization` is the request's single Authorization
   * header value; `args` is the tools/call `arguments`. Never throws.
   */
  dispatch(authorization: unknown, args: unknown): Promise<DispatchResult> {
    const parsed = parseArguments(args);
    const rawTask = parsed?.task;
    const fingerprint = taskFingerprint(rawTask);
    const targetId = parsed?.targetAgentId ?? null;

    const claims = this.deps.capabilities.verify(authorization);
    if (!claims) return Promise.resolve(this.deny(null, targetId, fingerprint, 'unauthenticated'));
    if (!parsed) {
      return Promise.resolve(this.deny(claims.agentId, null, fingerprint, 'invalid_arguments'));
    }
    const task = validateTaskText(rawTask);
    if (!task.ok) {
      return Promise.resolve(this.deny(claims.agentId, targetId, fingerprint, 'invalid_task'));
    }
    const session = this.deps.ptyManager.get(parsed.targetAgentId);
    if (!session) {
      return Promise.resolve(this.deny(claims.agentId, targetId, fingerprint, 'no_pty'));
    }

    return new Promise<DispatchResult>((resolve) => {
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(this.deny(claims.agentId, targetId, fingerprint, 'flush_timeout'));
      }, this.deps.flushDeadlineMs ?? TASK_DISPATCH_FLUSH_DEADLINE_MS);
      deadline.unref?.();
      session.afterParsed(() => {
        // A dispatch that already answered (deadline) must never write late.
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(
          this.evaluateAndWrite(
            authorization,
            parsed.targetAgentId,
            session,
            task.text,
            fingerprint,
          ),
        );
      });
    });
  }

  /**
   * The synchronous block: re-verify, every rule, the mirror's modes, the
   * write. Must stay free of await/promises -- that is the whole guarantee.
   */
  private evaluateAndWrite(
    authorization: unknown,
    targetId: number,
    session: DispatchPtySession,
    text: string,
    fingerprint: TaskFingerprint,
  ): DispatchResult {
    const claims = this.deps.capabilities.verify(authorization);
    if (!claims) return this.deny(null, targetId, fingerprint, 'unauthenticated');

    const denial = this.evaluateRules(claims, targetId, session);
    this.recordAttempt(this.callerAttempts, claims.agentId);
    if (denial) return this.deny(claims.agentId, targetId, fingerprint, denial);

    session.write(frameTaskInput(claims.agentId, text));
    this.inFlight.add(targetId);
    this.recordAttempt(this.targetWrites, targetId);
    this.audit(auditLine(claims.agentId, targetId, fingerprint, 'written'));
    const target = this.deps.store.get(targetId);
    return {
      ok: true,
      targetAgentId: targetId,
      displayName: target?.displayName,
      directoryName: target?.directoryName,
    };
  }

  /** The first rule that refuses, or null. Inputs: claims and live state only. */
  private evaluateRules(
    claims: CapabilityClaims,
    targetId: number,
    session: DispatchPtySession,
  ): DispatchDenial | null {
    const { store, ptyManager } = this.deps;

    // Rule 1: a non-default Workspace, and the caller curates it NOW.
    if (claims.workspaceId === DEFAULT_WORKSPACE_ID) return 'default_workspace';
    if (this.deps.curators.curatorOf(claims.workspaceId) !== claims.agentId) return 'not_curator';
    const caller = store.get(claims.agentId);
    if (!caller) return 'caller_missing';

    // Rule 2: the target.
    if (targetId === claims.agentId) return 'self';
    const target = store.get(targetId);
    if (!target) return 'target_missing';
    if (workspaceKey(target.workspaceId) !== claims.workspaceId) return 'cross_workspace';
    if (target.isExternal) return 'external';
    if (target.stopped) return 'stopped';
    // The session flushed must still be the one the manager holds for it.
    if (!ptyManager.has(targetId) || ptyManager.get(targetId) !== session || session.hasExited) {
      return 'no_pty';
    }
    if (target.leadAgentId !== undefined || target.spawnToolUseId !== undefined) return 'teammate';

    // Rule 3: no bypass anywhere; roles never widen. Undefined = unknown =
    // refused (only a PTY launch records `false`).
    if (this.deps.hostBypassEnabled()) return 'bypass_host';
    if (caller.launchedWithBypass !== false) return 'bypass_caller';
    if (target.launchedWithBypass !== false) return 'bypass_target';
    if (!rolesWithin(caller.permissionRoles ?? null, target.permissionRoles ?? null)) {
      return 'roles';
    }

    // Rule 4: the target's write guard is in force.
    if (!this.deps.guard.isGuardActive(targetId)) return 'guard_inactive';

    // Rule 5: idle in THIS PTY session, at a prompt that brackets pastes.
    if ((target.turnsCompletedThisSession ?? 0) < 1) return 'no_turn_completed';
    if (target.isWaiting !== true || target.permissionSent || target.activeToolIds.size !== 0) {
      return 'busy';
    }
    const modes = session.terminalModes();
    if (modes.alternateScreen) return 'alternate_screen';
    if (!modes.bracketedPaste) return 'no_bracketed_paste';

    // Rule 6: the operator is not typing there, and no dispatch is pending.
    const now = this.now();
    const lastInput = this.deps.operatorInput.lastInputAtFor(targetId);
    if (lastInput !== undefined && now - lastInput < TASK_DISPATCH_OPERATOR_QUIET_MS) {
      return 'operator_typing';
    }
    if (this.inFlight.has(targetId)) return 'in_flight';

    // Rule 7: rate limits.
    if (
      this.countRecent(this.callerAttempts, claims.agentId, now) >=
      TASK_DISPATCH_RATE_MAX_PER_CALLER
    ) {
      return 'rate_caller';
    }
    if (this.countRecent(this.targetWrites, targetId, now) >= TASK_DISPATCH_RATE_MAX_PER_TARGET) {
      return 'rate_target';
    }
    return null;
  }

  private countRecent(table: Map<number, number[]>, id: number, now: number): number {
    const recent = (table.get(id) ?? []).filter((at) => now - at < TASK_DISPATCH_RATE_WINDOW_MS);
    if (recent.length === 0) table.delete(id);
    else table.set(id, recent);
    return recent.length;
  }

  private recordAttempt(table: Map<number, number[]>, id: number): void {
    const now = this.now();
    this.countRecent(table, id, now);
    table.set(id, [...(table.get(id) ?? []), now]);
  }

  private deny(
    callerId: number | null,
    targetId: number | null,
    fingerprint: TaskFingerprint,
    reason: DispatchDenial,
  ): DispatchResult {
    this.audit(auditLine(callerId, targetId, fingerprint, `denied:${reason}`));
    return { ok: false };
  }
}

interface TaskFingerprint {
  length: number;
  sha256: string;
}

/** Length and sha256 of what was sent as the task -- never the task itself. */
function taskFingerprint(task: unknown): TaskFingerprint {
  if (typeof task !== 'string') return { length: 0, sha256: '-' };
  return { length: task.length, sha256: crypto.createHash('sha256').update(task).digest('hex') };
}

function auditLine(
  callerId: number | null,
  targetId: number | null,
  fingerprint: TaskFingerprint,
  outcome: string,
): string {
  return (
    `[Pixel Agents] Task dispatch: caller=${callerId ?? 'unknown'} target=${targetId ?? 'invalid'} ` +
    `length=${fingerprint.length} sha256=${fingerprint.sha256} outcome=${outcome}`
  );
}
