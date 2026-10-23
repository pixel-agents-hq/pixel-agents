import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import {
  type ApprovalLogEntry,
  BOARD_DENY_MESSAGE,
  PermissionApprovals,
  type PermissionWaitResult,
} from '../src/permissions/approvalRegistry.js';
import { appendApprovalLog, formatApprovalLogLine } from '../src/permissions/approvalsLog.js';
import {
  PERMISSION_DETAIL_CHANGE_LINES,
  PERMISSION_DETAIL_MAX_CHARS,
  PERMISSION_WAIT_MS,
  PERMISSION_WAIT_PATH,
} from '../src/permissions/constants.js';
import { approvalsSwitchedOff } from '../src/permissions/killSwitch.js';
import {
  formatPermissionDetail,
  shortPermissionDetail,
} from '../src/permissions/permissionDetail.js';
import {
  parsePermissionWaitBody,
  registerPermissionRoutes,
} from '../src/permissions/permissionRoutes.js';
import type { AgentState } from '../src/types.js';

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    isExternal: true,
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/** A store with one local agent (id 1, session sess-1) and a broadcast log. */
function setup(opts: { switchedOff?: boolean } = {}) {
  const store = new AgentStateStore();
  store.set(1, agent({ directoryName: 'hobbyfi-blog' }));
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => broadcasts.push(m));
  const logged: ApprovalLogEntry[] = [];
  const approvals = new PermissionApprovals({
    store,
    isSwitchedOff: () => opts.switchedOff ?? false,
    log: (e) => logged.push(e),
    resolveAgentMs: 1_000,
    resolveAgentPollMs: 100,
  });
  return { store, approvals, broadcasts, logged };
}

function request(requestId = 'req-1', sessionId = 'sess-1') {
  return {
    requestId,
    sessionId,
    toolName: 'Bash',
    toolInput: { command: 'rm -rf build && npm test' },
    cwd: '/home/u/hobbyfi-blog',
  };
}

/** Whether a promise has settled, without awaiting it forever. */
async function settled<T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> {
  const marker = Symbol('pending');
  const value = await Promise.race([p, Promise.resolve(marker)]);
  return value === marker ? { done: false } : { done: true, value: value as T };
}

describe('formatPermissionDetail', () => {
  it('shows a Bash or PowerShell command in full', () => {
    expect(formatPermissionDetail('Bash', { command: 'git push --force' })).toBe(
      'git push --force',
    );
    expect(formatPermissionDetail('PowerShell', { command: 'Remove-Item -Recurse x' })).toBe(
      'Remove-Item -Recurse x',
    );
  });

  it('caps a long command with a visible marker', () => {
    const long = 'x'.repeat(PERMISSION_DETAIL_MAX_CHARS + 500);
    const detail = formatPermissionDetail('Bash', { command: long });
    expect(detail.startsWith('x'.repeat(PERMISSION_DETAIL_MAX_CHARS))).toBe(true);
    expect(detail).toContain('…[500 more chars]');
  });

  it('shows the file path and the first lines of an Edit', () => {
    const detail = formatPermissionDetail('Edit', {
      file_path: '/repo/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(detail).toBe('/repo/a.ts\n\n- const a = 1;\n+ const a = 2;');
  });

  it('shows only the first lines of a Write, saying how many are hidden', () => {
    const content = Array.from({ length: PERMISSION_DETAIL_CHANGE_LINES + 5 }, (_, i) => `l${i}`);
    const detail = formatPermissionDetail('Write', {
      file_path: '/repo/b.ts',
      content: content.join('\n'),
    });
    expect(detail.startsWith('/repo/b.ts\n\nl0\nl1')).toBe(true);
    expect(detail).toContain(`l${PERMISSION_DETAIL_CHANGE_LINES - 1}`);
    expect(detail).not.toContain(`l${PERMISSION_DETAIL_CHANGE_LINES}\n`);
    expect(detail).toContain('…[5 more lines]');
  });

  it('shows every edit of a MultiEdit', () => {
    const detail = formatPermissionDetail('MultiEdit', {
      file_path: '/repo/c.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(detail).toBe('/repo/c.ts\n\n- a\n+ b\n- c\n+ d');
  });

  it('shows the URL of a WebFetch', () => {
    expect(formatPermissionDetail('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toBe(
      'https://x.dev',
    );
  });

  it('shows an MCP or unknown tool as its name and compact JSON, capped', () => {
    expect(formatPermissionDetail('mcp__gh__create_issue', { title: 'Bug', n: 1 })).toBe(
      'mcp__gh__create_issue {"title":"Bug","n":1}',
    );
    const big = formatPermissionDetail('mcp__x__y', { blob: 'z'.repeat(5000) });
    expect(big.length).toBeLessThan(PERMISSION_DETAIL_MAX_CHARS + 40);
    expect(big).toContain('more chars]');
  });

  it('never throws on a missing or odd input', () => {
    expect(formatPermissionDetail('Bash', undefined)).toBe('Bash {}');
    expect(formatPermissionDetail('Edit', 'nope')).toBe('Edit "nope"');
  });

  it('folds the log detail onto one short line', () => {
    expect(shortPermissionDetail('a\nb')).toBe('a ⏎ b');
    expect(shortPermissionDetail('y'.repeat(500)).length).toBeLessThan(230);
  });
});

describe('PermissionApprovals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts the pending request, and an answer resolves the wait with the decision', async () => {
    const { approvals, broadcasts, logged } = setup();
    const wait = approvals.wait(request());
    expect(broadcasts).toEqual([
      expect.objectContaining({
        type: 'permissionPending',
        requestId: 'req-1',
        id: 1,
        tool: 'Bash',
        detail: 'rm -rf build && npm test',
      }),
    ]);
    expect(approvals.pendingMessages()).toHaveLength(1);

    expect(approvals.answer('req-1', 'allow', '127.0.0.1 (localhost:3100)')).toBe(true);
    expect(await wait).toEqual({ decision: { behavior: 'allow' } });
    expect(broadcasts.at(-1)).toEqual({
      type: 'permissionResolved',
      requestId: 'req-1',
      id: 1,
      outcome: 'allowed',
    });
    expect(approvals.pendingMessages()).toEqual([]);
    expect(logged).toEqual([
      expect.objectContaining({
        agentId: 1,
        repo: 'hobbyfi-blog',
        tool: 'Bash',
        detail: 'rm -rf build && npm test',
        decision: 'allow',
        client: '127.0.0.1 (localhost:3100)',
      }),
    ]);
  });

  it('a deny carries the board message, and nothing else', async () => {
    const { approvals, broadcasts } = setup();
    const wait = approvals.wait(request());
    approvals.answer('req-1', 'deny');
    expect(await wait).toEqual({ decision: { behavior: 'deny', message: BOARD_DENY_MESSAGE } });
    expect(broadcasts.at(-1)).toMatchObject({ outcome: 'denied' });
  });

  it('refuses junk answers and a second answer to the same request', async () => {
    const { approvals, logged } = setup();
    const wait = approvals.wait(request());
    expect(approvals.answer('req-1', 'always')).toBe(false);
    expect(approvals.answer(42, 'allow')).toBe(false);
    expect(approvals.answer('other', 'allow')).toBe(false);
    expect((await settled(wait)).done).toBe(false);
    expect(approvals.answer('req-1', 'deny')).toBe(true);
    expect(approvals.answer('req-1', 'allow')).toBe(false);
    expect((await wait).decision?.behavior).toBe('deny');
    expect(logged).toHaveLength(1);
  });

  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])(
    '%s for the session after the request resolves it as answeredInTerminal, with no decision',
    async (event) => {
      const { approvals, broadcasts, logged } = setup();
      const wait = approvals.wait(request());
      approvals.observeHookEvent({ hook_event_name: event, session_id: 'sess-1' });
      expect(await wait).toEqual({});
      expect(broadcasts.at(-1)).toMatchObject({
        type: 'permissionResolved',
        outcome: 'answeredInTerminal',
      });
      expect(approvals.answer('req-1', 'allow')).toBe(false);
      expect(logged).toEqual([]);
    },
  );

  it('ignores events from other sessions, other event kinds, and relayed sessions', async () => {
    const { approvals } = setup();
    const wait = approvals.wait(request());
    approvals.observeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'sess-2' });
    approvals.observeHookEvent({ hook_event_name: 'Notification', session_id: 'sess-1' });
    approvals.observeHookEvent({ hook_event_name: 'PermissionRequest', session_id: 'sess-1' });
    approvals.observeHookEvent({
      hook_event_name: 'Stop',
      session_id: 'sess-1',
      pixel_source: { id: 'laptop', label: 'Laptop', kind: 'computer' },
    });
    expect((await settled(wait)).done).toBe(false);
    approvals.dispose();
  });

  it('expires after the wait window with no decision', async () => {
    vi.useFakeTimers();
    const { approvals, broadcasts } = setup();
    const wait = approvals.wait(request());
    await vi.advanceTimersByTimeAsync(PERMISSION_WAIT_MS - 1);
    expect((await settled(wait)).done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await wait).toEqual({});
    expect(broadcasts.at(-1)).toMatchObject({ outcome: 'expired' });
  });

  describe('relayed remote sessions', () => {
    const MAC = { id: 'mac', label: 'Mac', kind: 'computer' as const };
    function withRemoteAgent() {
      const ctx = setup();
      ctx.store.set(2, agent({ id: 2, sessionId: 'mac:s1', remoteSource: MAC }));
      return ctx;
    }

    it('a relayed request waits on the board and gets the answer', async () => {
      const { approvals, broadcasts } = withRemoteAgent();
      const wait = approvals.wait({ ...request('req-r', 'mac:s1'), remote: true });
      expect(broadcasts).toEqual([
        expect.objectContaining({ type: 'permissionPending', requestId: 'req-r', id: 2 }),
      ]);
      expect(approvals.answer('req-r', 'deny')).toBe(true);
      expect((await wait).decision).toEqual({ behavior: 'deny', message: BOARD_DENY_MESSAGE });
    });

    it('a relayed request never matches a local agent, nor a local one a relayed agent', async () => {
      const { approvals, broadcasts } = withRemoteAgent();
      expect(await approvals.wait({ ...request('req-a', 'sess-1'), remote: true })).toEqual({});
      expect(await approvals.wait(request('req-b', 'mac:s1'))).toEqual({});
      expect(broadcasts.filter((m) => m.type === 'permissionPending')).toEqual([]);
    });

    it('only Stop or SessionEnd from the relayed session settles it (async hooks reorder)', async () => {
      const { approvals } = withRemoteAgent();
      const wait = approvals.wait({ ...request('req-r', 'mac:s1'), remote: true });
      const event = (name: string, remote = true) => ({
        hook_event_name: name,
        session_id: 'mac:s1',
        ...(remote ? { pixel_source: MAC } : {}),
      });
      approvals.observeHookEvent(event('PreToolUse'));
      approvals.observeHookEvent(event('PostToolUse'));
      approvals.observeHookEvent(event('Stop', false)); // not relayed: not this session
      expect((await settled(wait)).done).toBe(false);
      approvals.observeHookEvent(event('Stop'));
      expect(await wait).toEqual({});
    });
  });

  describe('AskUserQuestion', () => {
    const QUESTIONS = {
      questions: [
        {
          question: 'Which meter?',
          header: 'Meter',
          multiSelect: false,
          options: [{ label: 'Server room', description: 'wall' }, { label: 'Limit meter' }],
        },
        {
          question: 'Which hosts?',
          header: 'Hosts',
          multiSelect: true,
          options: [{ label: 'PC' }, { label: 'Mac' }],
        },
      ],
    };
    const ask = (requestId = 'req-q') => ({
      ...request(requestId),
      toolName: 'AskUserQuestion',
      toolInput: QUESTIONS,
    });

    it('announces the questions with the request', async () => {
      const { approvals, broadcasts } = setup();
      void approvals.wait(ask());
      expect(broadcasts[0]).toMatchObject({
        type: 'permissionPending',
        tool: 'AskUserQuestion',
        questions: [
          {
            question: 'Which meter?',
            header: 'Meter',
            multiSelect: false,
            options: [{ label: 'Server room', description: 'wall' }, { label: 'Limit meter' }],
          },
          {
            question: 'Which hosts?',
            multiSelect: true,
            options: [{ label: 'PC' }, { label: 'Mac' }],
          },
        ],
      });
      approvals.dispose();
    });

    it('allow needs answers that fit; the decision carries them and the log reads them', async () => {
      const { approvals, logged } = setup();
      const wait = approvals.wait(ask());
      expect(approvals.answer('req-q', 'allow')).toBe(false);
      expect(
        approvals.answer('req-q', 'allow', undefined, [{ options: [0, 1] }, { options: [0] }]),
      ).toBe(false);
      expect(approvals.answer('req-q', 'allow', undefined, [{ options: [0] }])).toBe(false);
      const answers = [{ options: [1] }, { options: [1, 0], other: ' NAS ' }];
      expect(approvals.answer('req-q', 'allow', 'phone', answers)).toBe(true);
      expect((await wait).decision).toEqual({
        behavior: 'allow',
        answers: [{ options: [1] }, { options: [0, 1], other: 'NAS' }],
      });
      expect(logged[0].detail).toBe('Meter: Limit meter; Hosts: PC, Mac, NAS');
    });

    it('deny needs no answers', async () => {
      const { approvals } = setup();
      const wait = approvals.wait(ask());
      expect(approvals.answer('req-q', 'deny')).toBe(true);
      expect((await wait).decision?.behavior).toBe('deny');
    });

    it('a malformed AskUserQuestion stays an ordinary Allow / Deny request', async () => {
      const { approvals, broadcasts } = setup();
      const wait = approvals.wait({ ...ask(), toolInput: { questions: 'nope' } });
      expect(broadcasts[0].questions).toBeUndefined();
      expect(approvals.answer('req-q', 'allow')).toBe(true);
      expect((await wait).decision).toEqual({ behavior: 'allow' });
    });
  });

  it('answers at once with no decision when switched off', async () => {
    const { approvals, broadcasts } = setup({ switchedOff: true });
    expect(await approvals.wait(request())).toEqual({});
    expect(broadcasts).toEqual([]);
  });

  it('waits briefly for a session not on the board yet, then gives up silently', async () => {
    vi.useFakeTimers();
    const { store, approvals, broadcasts } = setup();
    const late = approvals.wait(request('req-late', 'sess-late'));
    expect(broadcasts).toEqual([]);
    store.set(3, agent({ id: 3, sessionId: 'sess-late' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(broadcasts).toEqual([expect.objectContaining({ requestId: 'req-late', id: 3 })]);
    approvals.answer('req-late', 'allow');
    expect((await late).decision).toEqual({ behavior: 'allow' });

    const never = approvals.wait(request('req-never', 'sess-unknown'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await never).toEqual({});
  });

  it('a terminal answer during agent resolution is not missed', async () => {
    vi.useFakeTimers();
    const { store, approvals, broadcasts } = setup();
    const wait = approvals.wait(request('req-x', 'sess-x'));
    approvals.observeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'sess-x' });
    store.set(4, agent({ id: 4, sessionId: 'sess-x' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(await wait).toEqual({});
    // Never announced, so never resolved on the board either.
    expect(broadcasts).toEqual([]);
  });

  it('refuses a replayed requestId', async () => {
    const { approvals } = setup();
    const first = approvals.wait(request());
    expect(await approvals.wait(request())).toEqual({});
    approvals.answer('req-1', 'allow');
    expect((await first).decision?.behavior).toBe('allow');
  });

  it('resolves as answeredInTerminal when the agent leaves the board or the hook goes away', async () => {
    const { store, approvals, broadcasts } = setup();
    const a = approvals.wait(request('req-a'));
    store.delete(1);
    expect(await a).toEqual({});
    expect(broadcasts.at(-1)).toMatchObject({ requestId: 'req-a', outcome: 'answeredInTerminal' });

    store.set(1, agent());
    const b = approvals.wait(request('req-b'));
    approvals.abandon('req-b');
    expect(await b).toEqual({});
    expect(broadcasts.at(-1)).toMatchObject({ requestId: 'req-b', outcome: 'answeredInTerminal' });
  });

  it('prefers the top-level agent over a teammate sharing the session', async () => {
    const { store, approvals, broadcasts } = setup();
    store.delete(1);
    store.set(5, agent({ id: 5, sessionId: 'sess-t', leadAgentId: 6 }));
    store.set(6, agent({ id: 6, sessionId: 'sess-t' }));
    void approvals.wait(request('req-t', 'sess-t'));
    expect(broadcasts.at(-1)).toMatchObject({ type: 'permissionPending', id: 6 });
    approvals.dispose();
  });

  it('dispose answers every wait with no decision', async () => {
    const { approvals } = setup();
    const wait = approvals.wait(request());
    approvals.dispose();
    expect(await wait).toEqual({});
    expect(await approvals.wait(request('req-2'))).toEqual({});
  });
});

describe('approvals kill switch', () => {
  it('is on by default; env off values or approvalsEnabled:false switch it off', () => {
    expect(approvalsSwitchedOff(undefined, undefined)).toBe(false);
    expect(approvalsSwitchedOff(undefined, {})).toBe(false);
    expect(approvalsSwitchedOff('on', { approvalsEnabled: true })).toBe(false);
    for (const off of ['off', 'OFF', '0', 'false', 'no']) {
      expect(approvalsSwitchedOff(off, {})).toBe(true);
    }
    expect(approvalsSwitchedOff(undefined, { approvalsEnabled: false })).toBe(true);
  });

  describe('config round-trip', () => {
    let tempHome: string;
    let originalHome: string | undefined;
    let originalProfile: string | undefined;
    beforeEach(() => {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-approvals-cfg-'));
      originalHome = process.env.HOME;
      originalProfile = process.env.USERPROFILE;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
    });
    afterEach(() => {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalProfile;
      fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it('a hand-set approvalsEnabled:false survives every other config write', () => {
      fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
      const file = path.join(tempHome, '.pixel-agents', 'config.json');
      fs.writeFileSync(file, JSON.stringify({ approvalsEnabled: false }));
      const cfg = readConfig();
      expect(cfg.approvalsEnabled).toBe(false);
      cfg.externalAssetDirectories.push('/x');
      writeConfig(cfg);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).approvalsEnabled).toBe(false);
      // Absent stays absent (default on), never written as true.
      fs.writeFileSync(file, JSON.stringify({}));
      writeConfig(readConfig());
      expect('approvalsEnabled' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false);
    });

    it('the connect snapshot carries pending requests, for read-only clients too', () => {
      const { store, approvals } = setup();
      void approvals.wait(request());
      for (const privileged of [true, false]) {
        const sent: Array<Record<string, unknown>> = [];
        handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
          store,
          cache: null,
          privileged,
          approvals,
        });
        const pending = sent.filter((m) => m.type === 'permissionPending');
        expect(pending).toEqual([expect.objectContaining({ requestId: 'req-1', id: 1 })]);
        // After the agents exist on the client (existingAgents + layoutLoaded).
        expect(sent.findIndex((m) => m.type === 'permissionPending')).toBeGreaterThan(
          sent.findIndex((m) => m.type === 'layoutLoaded'),
        );
      }
      approvals.dispose();
    });

    it('appends one tab-separated line per answer to approvals.log', () => {
      const file = path.join(tempHome, '.pixel-agents', 'approvals.log');
      const entry: ApprovalLogEntry = {
        time: '2026-10-18T10:00:00.000Z',
        agentId: 1,
        repo: 'hobbyfi-blog',
        tool: 'Bash',
        detail: 'npm\ttest',
        decision: 'allow',
        client: '127.0.0.1 (localhost)',
      };
      appendApprovalLog(entry, file);
      appendApprovalLog({ ...entry, decision: 'deny', client: undefined }, file);
      const lines = fs.readFileSync(file, 'utf-8').trimEnd().split('\n');
      expect(lines).toEqual([
        formatApprovalLogLine(entry).trimEnd(),
        formatApprovalLogLine({ ...entry, decision: 'deny', client: undefined }).trimEnd(),
      ]);
      expect(lines[0]).toBe(
        '2026-10-18T10:00:00.000Z\tallow\tagent=1\trepo=hobbyfi-blog\ttool=Bash\tclient=127.0.0.1 (localhost)\tdetail=npm test',
      );
      expect(lines[1]).toContain('\tdeny\t');
      expect(lines[1]).toContain('client=?');
    });
  });
});

describe('answerPermission over the client-message gate', () => {
  function ctx(approvals: PermissionApprovals, store: AgentStateStore, privileged: boolean) {
    return { store, cache: null, privileged, approvals, client: 'phone' } as ClientMessageContext;
  }

  it('a read-only client is refused: the request stays pending and the wait unanswered', async () => {
    const { store, approvals, logged } = setup();
    const wait = approvals.wait(request());
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage(
      { type: 'answerPermission', requestId: 'req-1', behavior: 'allow' },
      (m) => sent.push(m),
      ctx(approvals, store, false),
    );
    expect((await settled(wait)).done).toBe(false);
    expect(approvals.pendingMessages()).toHaveLength(1);
    expect(logged).toEqual([]);
    approvals.dispose();
  });

  it('an unspecified privilege is read-only too (the safe default)', async () => {
    const { store, approvals } = setup();
    const wait = approvals.wait(request());
    handleClientMessage(
      { type: 'answerPermission', requestId: 'req-1', behavior: 'allow' },
      () => {},
      { store, cache: null, approvals },
    );
    expect((await settled(wait)).done).toBe(false);
    approvals.dispose();
  });

  it('a privileged client answers, and the log names the client', async () => {
    const { store, approvals, logged } = setup();
    const wait = approvals.wait(request());
    handleClientMessage(
      { type: 'answerPermission', requestId: 'req-1', behavior: 'deny' },
      () => {},
      ctx(approvals, store, true),
    );
    expect((await wait).decision?.behavior).toBe('deny');
    expect(logged[0]).toMatchObject({ decision: 'deny', client: 'phone' });
  });
});

describe('POST /api/permissions/wait', () => {
  it('validates the body', () => {
    expect(parsePermissionWaitBody(null)).toBeNull();
    expect(parsePermissionWaitBody({ session_id: 's', tool_name: 'Bash' })).toBeNull();
    expect(parsePermissionWaitBody({ requestId: 'r', tool_name: 'Bash' })).toBeNull();
    expect(
      parsePermissionWaitBody({
        requestId: 'r',
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/x',
      }),
    ).toEqual({
      requestId: 'r',
      sessionId: 's',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      cwd: '/x',
      remote: false,
    });
    expect(
      parsePermissionWaitBody({ requestId: 'r', session_id: 's', tool_name: 'B', pixel_source: {} })
        ?.remote,
    ).toBe(true);
  });

  it('needs the bearer token, and holds the request until it is answered', async () => {
    const app = Fastify();
    const { approvals } = setup();
    registerPermissionRoutes(app, { token: 'tok', approvals });
    await app.ready();
    const body = { requestId: 'req-1', session_id: 'sess-1', tool_name: 'Bash', tool_input: {} };

    const unauth = await app.inject({ method: 'POST', url: PERMISSION_WAIT_PATH, payload: body });
    expect(unauth.statusCode).toBe(401);
    expect(approvals.pendingMessages()).toEqual([]);

    // inject() is lazy until something thens it; Promise.resolve starts it.
    const pending = Promise.resolve(
      app.inject({
        method: 'POST',
        url: PERMISSION_WAIT_PATH,
        headers: { authorization: 'Bearer tok' },
        payload: body,
      }),
    );
    await vi.waitFor(() => expect(approvals.pendingMessages()).toHaveLength(1), {
      timeout: 10_000,
    });
    approvals.answer('req-1', 'allow');
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json() as PermissionWaitResult).toEqual({ decision: { behavior: 'allow' } });

    const bad = await app.inject({
      method: 'POST',
      url: PERMISSION_WAIT_PATH,
      headers: { authorization: 'Bearer tok' },
      payload: { nope: true },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  }, 30_000);
});
