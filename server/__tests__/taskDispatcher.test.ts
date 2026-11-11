import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import {
  TASK_DISPATCH_OPERATOR_QUIET_MS,
  TASK_DISPATCH_RATE_MAX_PER_CALLER,
  TASK_DISPATCH_RATE_MAX_PER_TARGET,
  TASK_DISPATCH_RATE_WINDOW_MS,
} from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { TaskDispatcher } from '../src/taskDispatch/taskDispatcher.js';
import { createStoppedAgent } from '../src/terminal/standaloneAgentRecords.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import {
  DISABLE_BRACKETED_PASTE,
  DispatchHarness,
  ENABLE_BRACKETED_PASTE,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
} from './taskDispatchHarness.js';

/**
 * Task dispatch authorization (D1): every rule refuses with the same result,
 * the audit line names the rule, and an allowed dispatch writes exactly the
 * framed task -- decided inside the mirror-flush callback, in one synchronous
 * block, from verify() claims and live state only.
 */

const PASTE = (caller: number, text: string) =>
  `\u001b[200~[Task from Workspace KB Writer (agent ${caller})]\n${text}\u001b[201~\r`;

let h: DispatchHarness;
let ws: { id: string; dir: string };
let curator: { id: number; token?: string };
let target: { id: number; token?: string };
let auth: string;

function dispatchTo(targetAgentId: number, task = 'Summarize the notes', authorization = auth) {
  return h.dispatcher.dispatch(authorization, { targetAgentId, task });
}

async function expectDenied(
  promise: ReturnType<typeof dispatchTo>,
  reason: string,
  targetId = target.id,
): Promise<void> {
  const before = h.ptyOf(targetId).written.length;
  expect(await promise).toEqual({ ok: false });
  expect(h.lastAuditOutcome()).toBe(`denied:${reason}`);
  expect(h.ptyOf(targetId).written.length).toBe(before);
}

beforeEach(() => {
  h = new DispatchHarness();
  ws = h.workspace('alpha');
  curator = h.launch({ directoryPath: ws.dir });
  target = h.launch({ directoryPath: ws.dir });
  expect(h.curators.appoint(ws.id, curator.id)).toEqual({ ok: true });
  h.makeReady(target.id);
  auth = `Bearer ${curator.token}`;
});

afterEach(() => h.dispose());

describe('an allowed dispatch', () => {
  it('writes exactly: paste start, prefix line, LF, task, paste end, CR outside', async () => {
    const result = await dispatchTo(target.id, 'line one\nline two');
    expect(result).toMatchObject({ ok: true, targetAgentId: target.id });
    expect(h.ptyOf(target.id).written).toEqual([PASTE(curator.id, 'line one\nline two')]);
    expect(h.lastAuditOutcome()).toBe('written');
  });

  it('normalizes CRLF to LF before writing', async () => {
    await dispatchTo(target.id, 'a\r\nb');
    expect(h.ptyOf(target.id).written).toEqual([PASTE(curator.id, 'a\nb')]);
  });

  it("returns the target's displayName and directoryName", async () => {
    h.store.get(target.id)!.displayName = 'Writer';
    const result = await dispatchTo(target.id);
    expect(result).toEqual({
      ok: true,
      targetAgentId: target.id,
      displayName: 'Writer',
      directoryName: h.store.get(target.id)!.directoryName,
    });
  });

  it('audits caller, target, length and sha256 -- never the task or the token', async () => {
    const task = 'secret plan: rotate the keys';
    await dispatchTo(target.id, task);
    const line = h.audit[h.audit.length - 1];
    expect(line).toMatch(
      new RegExp(
        `^\\[Pixel Agents\\] Task dispatch: caller=${curator.id} target=${target.id} length=${task.length} sha256=[0-9a-f]{64} outcome=written$`,
      ),
    );
    for (const l of h.audit) {
      expect(l).not.toContain('secret plan');
      expect(l).not.toContain(curator.token!);
    }
  });
});

describe('rule 1: the caller curates a non-default Workspace', () => {
  it('refuses a caller that is not the curator', async () => {
    expect(h.curators.dismiss(ws.id)).toEqual({ ok: true });
    await expectDenied(dispatchTo(target.id), 'not_curator');
  });

  it('refuses an agent that is not the CURRENT curator (the target holds a token too)', async () => {
    await expectDenied(
      h.dispatcher.dispatch(`Bearer ${target.token}`, { targetAgentId: curator.id, task: 'x' }),
      'not_curator',
      curator.id,
    );
  });

  it('refuses a default-Workspace caller even holding a capability and the curator seat', async () => {
    const plain = h.launch({});
    expect(plain.token).toBeUndefined(); // the launcher never issues one there
    const agent = h.store.get(plain.id)!;
    const grant = h.capabilities.issue({
      agentId: plain.id,
      sessionId: agent.sessionId,
      workspaceId: undefined,
    });
    expect(h.curators.appoint(DEFAULT_WORKSPACE_ID, plain.id)).toEqual({ ok: true });
    const other = h.launch({});
    h.makeReady(other.id);
    await expectDenied(
      h.dispatcher.dispatch(`Bearer ${grant.token}`, { targetAgentId: other.id, task: 'x' }),
      'default_workspace',
      other.id,
    );
  });
});

describe('rule 2: the target', () => {
  it('refuses the caller itself', async () => {
    h.makeReady(curator.id);
    await expectDenied(dispatchTo(curator.id), 'self', curator.id);
  });

  it('refuses a target in another Workspace', async () => {
    const beta = h.workspace('beta');
    const stranger = h.launch({ directoryPath: beta.dir });
    h.makeReady(stranger.id);
    await expectDenied(dispatchTo(stranger.id), 'cross_workspace', stranger.id);
  });

  it('refuses a stopped record (no PTY), and a record marked stopped', async () => {
    const before = h.audit.length;
    const stoppedId = createStoppedAgent(
      { store: h.store, provider: { ...claudeProvider, getSessionDirs: () => [h.projectDir] } },
      { directoryPath: ws.dir },
    )!;
    expect(await dispatchTo(stoppedId)).toEqual({ ok: false });
    expect(h.audit.length).toBe(before + 1);
    expect(h.lastAuditOutcome()).toBe('denied:no_pty');

    h.store.get(target.id)!.stopped = true;
    await expectDenied(dispatchTo(target.id), 'stopped');
  });

  it('refuses an external agent', async () => {
    h.store.get(target.id)!.isExternal = true;
    await expectDenied(dispatchTo(target.id), 'external');
  });

  it('refuses a teammate or a background-spawn child', async () => {
    h.store.get(target.id)!.leadAgentId = curator.id;
    await expectDenied(dispatchTo(target.id), 'teammate');
    h.store.get(target.id)!.leadAgentId = undefined;
    h.store.get(target.id)!.spawnToolUseId = 'toolu_1';
    await expectDenied(dispatchTo(target.id), 'teammate');
  });

  it('refuses an unknown target id and malformed arguments', async () => {
    expect(await dispatchTo(999)).toEqual({ ok: false });
    expect(h.lastAuditOutcome()).toBe('denied:no_pty');
    for (const args of [
      null,
      [],
      { targetAgentId: '2', task: 'x' },
      { targetAgentId: 0, task: 'x' },
    ]) {
      expect(await h.dispatcher.dispatch(auth, args)).toEqual({ ok: false });
      expect(h.lastAuditOutcome()).toBe('denied:invalid_arguments');
    }
    expect(h.ptyOf(target.id).written).toEqual([]);
  });
});

describe('rule 3: no bypass anywhere, roles never widen', () => {
  it('refuses while the host-wide bypass setting is on, and allows once it is off', async () => {
    h.setHostBypass(true);
    await expectDenied(dispatchTo(target.id), 'bypass_host');
    h.setHostBypass(false);
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });

  it('refuses a TARGET launched with bypass, even after the setting is turned off', async () => {
    const risky = h.launch({ directoryPath: ws.dir, bypassPermissions: true });
    expect(h.spawned.at(-1)!.args).toContain('--dangerously-skip-permissions');
    h.makeReady(risky.id);
    h.setHostBypass(false);
    await expectDenied(dispatchTo(risky.id), 'bypass_target', risky.id);
  });

  it('refuses a CALLER curator launched with bypass, even after the setting is turned off', async () => {
    const beta = h.workspace('beta');
    const riskyCurator = h.launch({ directoryPath: beta.dir, bypassPermissions: true });
    const betaTarget = h.launch({ directoryPath: beta.dir });
    h.curators.appoint(beta.id, riskyCurator.id);
    h.makeReady(betaTarget.id);
    h.setHostBypass(false);
    await expectDenied(
      dispatchTo(betaTarget.id, 'x', `Bearer ${riskyCurator.token}`),
      'bypass_caller',
      betaTarget.id,
    );
  });

  it("refuses a target whose roles are not a subset of the caller's", async () => {
    const beta = h.workspace('beta');
    const narrow = h.launch({ directoryPath: beta.dir, permissionRoles: ['R'] });
    const wide = h.launch({ directoryPath: beta.dir, permissionRoles: ['R', 'E'] });
    const unrestricted = h.launch({ directoryPath: beta.dir, permissionRoles: null });
    const same = h.launch({ directoryPath: beta.dir, permissionRoles: ['R'] });
    h.curators.appoint(beta.id, narrow.id);
    for (const t of [wide, unrestricted, same]) h.makeReady(t.id);
    const narrowAuth = `Bearer ${narrow.token}`;
    await expectDenied(dispatchTo(wide.id, 'x', narrowAuth), 'roles', wide.id);
    await expectDenied(dispatchTo(unrestricted.id, 'x', narrowAuth), 'roles', unrestricted.id);
    expect(await dispatchTo(same.id, 'x', narrowAuth)).toMatchObject({ ok: true });
  });

  it('lets an unrestricted (null) caller target an unrestricted agent', async () => {
    expect(h.store.get(curator.id)!.permissionRoles).toBeNull();
    expect(h.store.get(target.id)!.permissionRoles).toBeNull();
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });
});

describe("rule 4: the target's write guard is active", () => {
  it('refuses when the hook chain is broken', async () => {
    h.chain = { hooksInstalled: false, preToolUsePresent: true, scriptPresent: true };
    h.guardStatus.refreshChain();
    await expectDenied(dispatchTo(target.id), 'guard_inactive');
  });

  it('refuses before the server has seen a verdict for the target session', async () => {
    h.seenVerdicts.clear();
    await expectDenied(dispatchTo(target.id), 'guard_inactive');
  });
});

describe('rule 5: idle in this PTY session, at a bracketed-paste prompt', () => {
  it('refuses a target that never completed a turn, and idle_prompt does not count', async () => {
    const fresh = h.launch({ directoryPath: ws.dir });
    h.ptyOf(fresh.id).emit(ENABLE_BRACKETED_PASTE);
    h.seenVerdicts.add(h.store.get(fresh.id)!.sessionId);
    h.store.get(fresh.id)!.isWaiting = true;
    await expectDenied(dispatchTo(fresh.id), 'no_turn_completed', fresh.id);
    h.runtime.handleHookEvent('claude', {
      session_id: h.store.get(fresh.id)!.sessionId,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    expect(h.store.get(fresh.id)!.turnsCompletedThisSession).toBe(0);
    await expectDenied(dispatchTo(fresh.id), 'no_turn_completed', fresh.id);
  });

  it('refuses a busy target: running a tool, awaiting permission, or with an active tool', async () => {
    const sessionId = h.store.get(target.id)!.sessionId;
    h.runtime.handleHookEvent('claude', {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    await expectDenied(dispatchTo(target.id), 'busy');
    h.completeTurn(target.id);
    h.store.get(target.id)!.permissionSent = true;
    await expectDenied(dispatchTo(target.id), 'busy');
    h.store.get(target.id)!.permissionSent = false;
    h.store.get(target.id)!.activeToolIds.add('toolu_x');
    await expectDenied(dispatchTo(target.id), 'busy');
  });

  it('refuses a STOPPED RECORD RESUMED with no new turn, then allows after one new turn', async () => {
    const resumed = h.createAndStart(ws.dir, {
      beforeStart: (id) => {
        // Left over from the previous process: a transcript (so it resumes)
        // and a waiting, idle-looking state with turns counted.
        const record = h.store.get(id)!;
        fs.mkdirSync(h.projectDir, { recursive: true });
        fs.writeFileSync(record.jsonlFile, '');
        record.isWaiting = true;
        record.permissionSent = false;
        record.turnsCompletedThisSession = 5;
        record.launchedWithBypass = false;
      },
    });
    expect(resumed.spawn.args.slice(0, 2)).toEqual([
      '--resume',
      h.store.get(resumed.id)!.sessionId,
    ]);
    expect(h.store.get(resumed.id)!.turnsCompletedThisSession).toBe(0);
    h.ptyOf(resumed.id).emit(ENABLE_BRACKETED_PASTE);
    h.seenVerdicts.add(h.store.get(resumed.id)!.sessionId);
    await expectDenied(dispatchTo(resumed.id), 'no_turn_completed', resumed.id);

    h.completeTurn(resumed.id);
    expect(await dispatchTo(resumed.id)).toMatchObject({ ok: true });
  });

  it('counts a JSONL turn_duration as a completed turn', () => {
    const fresh = h.launch({ directoryPath: ws.dir });
    processTranscriptLine(
      fresh.id,
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
      h.store,
      h.runtime.waitingTimers,
      h.runtime.permissionTimers,
    );
    expect(h.store.get(fresh.id)!.turnsCompletedThisSession).toBe(1);
  });
});

describe('mirror timing: modes are read only after the flush', () => {
  it('refuses when a not-yet-parsed chunk turns bracketed paste off, allows once it is back on', async () => {
    const pty = h.ptyOf(target.id);
    const session = h.manager.get(target.id)!;
    await new Promise<void>((resolve) => session.afterParsed(resolve));
    expect(session.terminalModes()).toEqual({ bracketedPaste: true, alternateScreen: false });
    pty.emit(DISABLE_BRACKETED_PASTE);
    // The chunk is queued, not parsed: a synchronous read would still say "on".
    expect(session.terminalModes().bracketedPaste).toBe(true);
    await expectDenied(dispatchTo(target.id), 'no_bracketed_paste');

    pty.emit(ENABLE_BRACKETED_PASTE);
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });

  it('refuses when a not-yet-parsed chunk enters the alternate screen, allows after it leaves', async () => {
    const pty = h.ptyOf(target.id);
    const session = h.manager.get(target.id)!;
    await new Promise<void>((resolve) => session.afterParsed(resolve));
    expect(session.terminalModes()).toEqual({ bracketedPaste: true, alternateScreen: false });
    pty.emit(ENTER_ALT_SCREEN);
    expect(session.terminalModes().alternateScreen).toBe(false);
    await expectDenied(dispatchTo(target.id), 'alternate_screen');

    pty.emit(LEAVE_ALT_SCREEN);
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });
});

describe('rule 6: operator input and the in-flight lock', () => {
  it('refuses within the quiet period after operator input, allows after it', async () => {
    h.operatorInput.record(target.id);
    h.nowMs += TASK_DISPATCH_OPERATOR_QUIET_MS - 1;
    await expectDenied(dispatchTo(target.id), 'operator_typing');
    h.nowMs += 1;
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });

  it('locks a target after a write until it visibly takes up new input', async () => {
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
    expect(h.dispatcher.isInFlight(target.id)).toBe(true);
    await expectDenied(dispatchTo(target.id), 'in_flight');

    // A turn end alone (it may be the PREVIOUS turn's late duplicate) keeps it.
    h.completeTurn(target.id);
    await expectDenied(dispatchTo(target.id), 'in_flight');

    // The target's JSONL shows the new prompt: released.
    processTranscriptLine(
      target.id,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'the task' } }),
      h.store,
      h.runtime.waitingTimers,
      h.runtime.permissionTimers,
    );
    expect(h.dispatcher.isInFlight(target.id)).toBe(false);
    h.completeTurn(target.id);
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });

    // A PreToolUse releases it too.
    h.runtime.handleHookEvent('claude', {
      session_id: h.store.get(target.id)!.sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    });
    expect(h.dispatcher.isInFlight(target.id)).toBe(false);
  });

  it('a tool-result user record does not release the lock', async () => {
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
    h.store.noteTurnActivity(target.id, 'userRecord');
    expect(h.dispatcher.isInFlight(target.id)).toBe(true);
  });
});

describe('rule 7: rate limits', () => {
  it('limits attempts per caller', async () => {
    h.curators.dismiss(ws.id); // every attempt is evaluated and refused
    for (let i = 0; i < TASK_DISPATCH_RATE_MAX_PER_CALLER; i++) {
      await dispatchTo(target.id);
      expect(h.lastAuditOutcome()).toBe('denied:not_curator');
    }
    h.curators.appoint(ws.id, curator.id);
    await expectDenied(dispatchTo(target.id), 'rate_caller');
    h.nowMs += TASK_DISPATCH_RATE_WINDOW_MS;
    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
  });

  it('limits writes per target', async () => {
    for (let i = 0; i < TASK_DISPATCH_RATE_MAX_PER_TARGET; i++) {
      expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
      h.store.noteTurnActivity(target.id, 'userPrompt');
    }
    await expectDenied(dispatchTo(target.id), 'rate_target');
  });
});

describe('authentication', () => {
  it('refuses a bad token, a raw server-style token, and a revoked one', async () => {
    await expectDenied(
      dispatchTo(target.id, 'x', 'Bearer pxa_kb_not-a-real-token'),
      'unauthenticated',
    );
    await expectDenied(
      dispatchTo(target.id, 'x', 'Bearer 0f3c9a7e-server-token'),
      'unauthenticated',
    );
    h.ptyOf(curator.id).exit(0); // the curator's process ends: its capability goes
    await expectDenied(dispatchTo(target.id), 'unauthenticated');
  });

  it('re-verifies inside the callback: a revocation after the request but before the flush writes nothing', async () => {
    const pending = dispatchTo(target.id);
    h.ptyOf(curator.id).exit(0);
    await expectDenied(pending, 'unauthenticated');
  });
});

describe('task text', () => {
  it('refuses an invalid task without flushing or writing', async () => {
    await expectDenied(dispatchTo(target.id, 'look at @src/secrets.ts'), 'invalid_task');
    await expectDenied(dispatchTo(target.id, 'end\u001b[201~rm -rf'), 'invalid_task');
  });
});

describe('structure: no await between the in-callback verify() and the write', () => {
  it('writes in the same synchronous turn as the second verify()', async () => {
    const pty = h.ptyOf(target.id);
    let verifyCalls = 0;
    let inVerifyTick = false;
    const realVerify = h.capabilities.verify.bind(h.capabilities);
    h.capabilities.verify = (presented: unknown) => {
      verifyCalls++;
      if (verifyCalls === 2) {
        inVerifyTick = true;
        // Any await (even a resolved promise) would let this run first.
        queueMicrotask(() => {
          inVerifyTick = false;
        });
      }
      return realVerify(presented);
    };
    const writesSeenInTick: boolean[] = [];
    pty.onWrite = () => writesSeenInTick.push(inVerifyTick);

    expect(await dispatchTo(target.id)).toMatchObject({ ok: true });
    expect(verifyCalls).toBe(2);
    expect(writesSeenInTick).toEqual([true]);
  });

  it('a dispatch whose flush misses the deadline answers and never writes later', async () => {
    let flushCallback: (() => void) | null = null;
    const written: string[] = [];
    const session = {
      hasExited: false,
      afterParsed: (cb: () => void) => {
        flushCallback = cb;
      },
      terminalModes: () => ({ bracketedPaste: true, alternateScreen: false }),
      write: (data: string) => written.push(data),
    };
    const audit: string[] = [];
    const dispatcher = new TaskDispatcher({
      store: h.store,
      ptyManager: { get: () => session, has: () => true },
      capabilities: h.capabilities,
      curators: h.curators,
      guard: h.guardStatus,
      operatorInput: h.operatorInput,
      hostBypassEnabled: () => false,
      audit: (line) => audit.push(line),
      flushDeadlineMs: 5,
    });
    expect(await dispatcher.dispatch(auth, { targetAgentId: target.id, task: 'x' })).toEqual({
      ok: false,
    });
    expect(audit.at(-1)).toContain('outcome=denied:flush_timeout');
    flushCallback!();
    expect(written).toEqual([]);
    dispatcher.dispose();
  });
});
