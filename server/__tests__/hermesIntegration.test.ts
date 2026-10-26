import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { hookAuth } from '../src/httpServer.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

// ── Multi-provider dispatch through the handler ─────────────────────────────

function testAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    isExternal: true,
    projectDir: '/test',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

describe('HookEventHandler: per-event provider routing', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (m) => messages.push(m));
    handler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
  });

  it('normalizes a Hermes wire event with the Hermes provider (claude-primary handler)', () => {
    agents.set(1, testAgent({ id: 1, sessionId: 'sess-h' }));
    handler.registerAgent('sess-h', 1);

    handler.handleEvent('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-h',
      tool_name: 'read_file',
      tool_input: { path: '/x/notes.md' },
      extra: { tool_call_id: 'tc-1' },
    });

    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start).toBeTruthy();
    expect(start!.status).toBe('Reading notes.md'); // Hermes formatter, not Claude's
    expect(start!.toolName).toBe('read_file');
  });

  it('pairs toolEnd on the current-sentinel contract', () => {
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);
    handler.handleEvent('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-h',
      tool_name: 'terminal',
      tool_input: { command: 'make' },
    });
    const correlatingId = agent.currentHookToolId;
    expect(correlatingId).toBeTruthy();
    handler.handleEvent('hermes', { hook_event_name: 'post_tool_call', session_id: 'sess-h' });
    const done = messages.find((m) => m.type === 'agentToolDone');
    expect(done!.toolId).toBe(correlatingId);
    expect(agent.currentHookToolId).toBeUndefined();
  });

  it('drops events for an unknown provider id (fail closed)', () => {
    agents.set(1, testAgent({ id: 1, sessionId: 'sess-h' }));
    handler.registerAgent('sess-h', 1);
    handler.handleEvent('codex', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-h',
      tool_name: 'shell',
    });
    expect(messages.find((m) => m.type === 'agentToolStart')).toBeUndefined();
  });

  it('keeps routing Claude events through Claude normalization on the same handler', () => {
    agents.set(1, testAgent({ id: 1, sessionId: 'sess-c' }));
    handler.registerAgent('sess-c', 1);
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-c',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start!.status).toBe('Running: npm test');
  });

  it('round-trips the Hermes permission bubble across approval events', () => {
    // Push-only provider: nothing but post_approval_response can retire the
    // bubble (there is no JSONL watcher to broadcast the clear).
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);

    handler.handleEvent('hermes', {
      hook_event_name: 'pre_approval_request',
      session_id: 'sess-h',
      tool_name: 'terminal',
      extra: { command: 'rm -rf /tmp/scratch', surface: 'cli' },
    });
    expect(messages.find((m) => m.type === 'agentToolPermission')).toBeTruthy();
    expect(agent.permissionSent).toBe(true);

    handler.handleEvent('hermes', {
      hook_event_name: 'post_approval_response',
      session_id: 'sess-h',
      extra: { choice: 'once', surface: 'cli' },
    });
    expect(messages.find((m) => m.type === 'agentToolPermissionClear')).toBeTruthy();
    expect(agent.permissionSent).toBe(false);
  });

  it('emits no permission clear when no bubble was raised', () => {
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);
    handler.handleEvent('hermes', {
      hook_event_name: 'post_approval_response',
      session_id: 'sess-h',
      extra: { choice: 'always' },
    });
    expect(messages.find((m) => m.type === 'agentToolPermissionClear')).toBeUndefined();
  });

  it('folds a Hermes turn-end usage snapshot into the context gauge', () => {
    // Push-only provider: the office never reads a transcript, so the only
    // path to a moving gauge is the snapshot carried on turn end.
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);

    handler.handleEvent('hermes', {
      hook_event_name: 'on_session_end',
      session_id: 'sess-h',
      extra: {
        completed: true,
        usage: { prompt_tokens: 5000, completion_tokens: 200, total_tokens: 5200 },
        context_length: 131072,
      },
    });
    expect(messages.find((m) => m.type === 'agentContextUsage')).toMatchObject({
      id: 1,
      contextTokens: 5200,
      maxContextTokens: 131072,
    });
    expect(agent.contextTokens).toBe(5200);
    expect(agent.maxContextTokens).toBe(131072);
  });

  it('leaves the gauge alone on a usage-less Hermes turn end', () => {
    const agent = testAgent({
      id: 1,
      sessionId: 'sess-h',
      contextTokens: 4200,
      maxContextTokens: 131072,
    });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);

    handler.handleEvent('hermes', {
      hook_event_name: 'on_session_end',
      session_id: 'sess-h',
      extra: { usage: null },
    });
    expect(messages.find((m) => m.type === 'agentContextUsage')).toBeUndefined();
    expect(agent.contextTokens).toBe(4200);
  });

  // ── Sub-characters for delegate_task children (scanner-born, no team) ──
  //
  // The dispatch used to sit behind `provider.team`, which Hermes does not
  // implement: its children would have been invisible. These pin the
  // push-only shape — the in-flight hook tool is the parent, the child's own
  // session id is the chip, and retirement is per-child.

  function of(type: string): Record<string, unknown>[] {
    return messages.filter((m) => m.type === type);
  }

  function delegateInFlight(agent: AgentState): string {
    handler.handleEvent('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-h',
      tool_name: 'delegate_task',
      tool_input: { goal: 'fix the flaky suite' },
    });
    return agent.currentHookToolId!;
  }

  it('renders a delegate child as a Subtask under the in-flight tool', () => {
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);
    const parentToolId = delegateInFlight(agent);

    // The bare delegation tool stays unrendered: hermesProvider lists
    // delegate_task in subagentToolNames, so the sub-character IS the display.
    expect(of('agentToolStart')).toHaveLength(0);

    handler.handleEvent('hermes', {
      hook_event_name: 'subagent_session_start',
      session_id: 'sess-h',
      subagent_session_id: '20261022_120000_abcdef',
      subagent_title: 'Subagent: fix the flaky suite',
      cwd: '/work/one',
    });

    expect(of('subagentToolStart')).toEqual([
      {
        type: 'subagentToolStart',
        id: 1,
        parentToolId,
        toolId: 'hermes-sub-20261022_120000_abcdef',
        status: 'Subtask: fix the flaky suite',
      },
    ]);
    expect(
      agent.activeSubagentToolIds.get(parentToolId)?.has('hermes-sub-20261022_120000_abcdef'),
    ).toBe(true);
  });

  it('retires the finished child only, and clears the group with its last chip', () => {
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);
    const parentToolId = delegateInFlight(agent);

    for (const kid of ['kid-a', 'kid-b', 'kid-c']) {
      handler.handleEvent('hermes', {
        hook_event_name: 'subagent_session_start',
        session_id: 'sess-h',
        subagent_session_id: kid,
        subagent_title: `Subagent: ${kid}`,
        cwd: '/work/one',
      });
    }
    expect(of('subagentToolStart')).toHaveLength(3);

    // Children finish out of order: retiring B must not despawn C.
    handler.handleEvent('hermes', {
      hook_event_name: 'subagent_session_end',
      session_id: 'sess-h',
      subagent_session_id: 'kid-b',
    });
    expect(of('subagentToolDone')).toEqual([
      { type: 'subagentToolDone', id: 1, parentToolId, toolId: 'hermes-sub-kid-b' },
    ]);
    expect(of('subagentClear')).toHaveLength(0);
    expect([...(agent.activeSubagentToolIds.get(parentToolId) ?? [])]).toEqual([
      'hermes-sub-kid-a',
      'hermes-sub-kid-c',
    ]);

    handler.handleEvent('hermes', {
      hook_event_name: 'subagent_session_end',
      session_id: 'sess-h',
      subagent_session_id: 'kid-c',
    });
    handler.handleEvent('hermes', {
      hook_event_name: 'subagent_session_end',
      session_id: 'sess-h',
      subagent_session_id: 'kid-a',
    });
    // The group despawns exactly once, when its last child leaves.
    expect(of('subagentClear')).toEqual([{ type: 'subagentClear', id: 1, parentToolId }]);
    expect(agent.activeSubagentToolIds.has(parentToolId)).toBe(false);

    // A late/duplicate goodbye for a child that is already gone is silent.
    messages.length = 0;
    handler.handleEvent('hermes', {
      hook_event_name: 'subagent_session_end',
      session_id: 'sess-h',
      subagent_session_id: 'kid-a',
    });
    expect(messages).toHaveLength(0);
  });

  it('stands idempotent on a replayed child birth and on a child with no group', () => {
    const agent = testAgent({ id: 1, sessionId: 'sess-h' });
    agents.set(1, agent);
    handler.registerAgent('sess-h', 1);
    const parentToolId = delegateInFlight(agent);

    const birth = {
      hook_event_name: 'subagent_session_start',
      session_id: 'sess-h',
      subagent_session_id: 'kid-1',
      subagent_title: 'Subagent: one',
      cwd: '/work/one',
    };
    handler.handleEvent('hermes', birth);
    handler.handleEvent('hermes', birth);
    // The stable chip key means a redelivery re-lands the same entry: the
    // bookkeeping never grows, and the webview's own add is per-toolId.
    expect(agent.activeSubagentToolIds.get(parentToolId)?.size).toBe(1);
    expect(agent.activeSubagentToolNames.get(parentToolId)?.get('hermes-sub-kid-1')).toBe('one');

    // A birth BEFORE any delegate_task is in flight has no parent to hang the
    // chip from: the event is dropped, never attached to some other tool.
    const other = testAgent({ id: 2, sessionId: 'sess-h2' });
    agents.set(2, other);
    handler.registerAgent('sess-h2', 2);
    const before = of('subagentToolStart').length;
    handler.handleEvent('hermes', { ...birth, session_id: 'sess-h2' });
    expect(of('subagentToolStart')).toHaveLength(before);
    expect(other.activeSubagentToolIds.size).toBe(0);
  });
});

// ── hookAuth: header, loopback query, rejection branches ────────────────────

describe('hookAuth', () => {
  interface MockReply {
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  }
  function makeReply(): MockReply {
    const reply: MockReply = { code: vi.fn(), send: vi.fn() };
    reply.code.mockImplementation(() => reply);
    return reply;
  }
  function requestOf(headers: Record<string, string>, url: string) {
    return { headers, url } as unknown as import('fastify').FastifyRequest;
  }
  async function runAuth(token: string, req: import('fastify').FastifyRequest): Promise<MockReply> {
    const reply = makeReply();
    await hookAuth(token)(req, reply as unknown as import('fastify').FastifyReply);
    return reply;
  }

  it('accepts the Bearer header', async () => {
    const reply = await runAuth(
      'tok',
      requestOf({ authorization: 'Bearer tok', host: 'evil.example' }, '/x'),
    );
    expect(reply.send).not.toHaveBeenCalled();
  });
  it('accepts ?token= over a loopback Host', async () => {
    for (const host of ['127.0.0.1:3100', 'localhost:3100', '[::1]:3100']) {
      const reply = await runAuth('tok', requestOf({ host }, '/api/hooks/hermes?token=tok'));
      expect(reply.send).not.toHaveBeenCalled();
    }
  });
  it('rejects ?token= over a non-loopback Host (rebinding shape)', async () => {
    const reply = await runAuth(
      'tok',
      requestOf({ host: 'evil.example:3100' }, '/api/hooks/hermes?token=tok'),
    );
    expect(reply.code).toHaveBeenCalledWith(401);
  });
  it('rejects a wrong token on either path', async () => {
    const reply = await runAuth(
      'tok',
      requestOf({ host: '127.0.0.1', authorization: 'Bearer no' }, '/x'),
    );
    expect(reply.code).toHaveBeenCalledWith(401);
    const reply2 = await runAuth(
      'tok',
      requestOf({ host: '127.0.0.1' }, '/api/hooks/hermes?token=no'),
    );
    expect(reply2.code).toHaveBeenCalledWith(401);
  });
  it('rejects a credential-less request', async () => {
    const reply = await runAuth('tok', requestOf({ host: '127.0.0.1' }, '/api/hooks/hermes'));
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});

// ── webviewReady handshake when Hermes IS available ─────────────────────────

describe('webviewReady with a second provider', () => {
  let tempHome: string;
  let hermesHome: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;
  let originalHermes: string | undefined;
  let store: AgentStateStore;

  function connect(): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m as Record<string, unknown>), {
      store,
      cache: null,
      privileged: true,
    });
    return sent; // async follow-ups land via settle() callers
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-multi-home-'));
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-multi-hermes-'));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    originalHermes = process.env.HERMES_HOME;
    process.env.HOME = tempHome;
    // win32: os.homedir() — which FileStateAdapter and the consent store
    // resolve through — reads USERPROFILE, not HOME. Stub both so the test
    // cannot see (or write) a real operator's ~/.pixel-agents on any platform.
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = hermesHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    if (originalHermes === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermes;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(hermesHome, { recursive: true, force: true });
  });

  it('broadcasts the union of capabilities and both providers', async () => {
    const sent = connect();
    await settle();
    const caps = sent.find((m) => m.type === 'providerCapabilities');
    expect(caps).toBeTruthy();
    const reading = caps!.readingTools as string[];
    expect(reading).toContain('Read'); // claude
    expect(reading).toContain('read_file'); // hermes
    const providers = caps!.providers as Array<{ id: string; displayName: string }>;
    expect(providers.map((p) => p.id)).toEqual(['claude', 'hermes']);
    expect(providers.find((p) => p.id === 'hermes')!.displayName).toBe('Hermes Agent');
  });

  it('answers one hooksStatus and one consent ask per provider', async () => {
    const sent = connect();
    await settle();
    const statuses = sent.filter((m) => m.type === 'hooksStatus');
    expect(statuses.map((s) => s.providerId).sort()).toEqual(['claude', 'hermes']);
    const asks = sent.filter((m) => m.type === 'hooksConsentRequest');
    expect(asks.map((a) => a.providerId).sort()).toEqual(['claude', 'hermes']);
    const hermesAsk = asks.find((a) => a.providerId === 'hermes');
    // The hermes ask ships hermes' own disclosure, never Claude's.
    expect(hermesAsk!.disclosure).toContain('Hermes Agent will POST those events');
    expect(hermesAsk!.disclosure).not.toContain('Claude Code');
  });

  it('an absent Hermes home removes every Hermes wire message', async () => {
    fs.rmSync(hermesHome, { recursive: true, force: true });
    const sent = connect();
    await settle();
    expect(sent.filter((m) => m.type === 'hooksStatus').map((s) => s.providerId)).toEqual([
      'claude',
    ]);
    const caps = sent.find((m) => m.type === 'providerCapabilities');
    expect((caps!.providers as Array<{ id: string }>).map((p) => p.id)).toEqual(['claude']);
    expect(caps!.readingTools).not.toContain('read_file');
  });
});
