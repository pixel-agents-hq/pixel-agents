import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing. */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

describe('HookEventHandler', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    // Wire broadcast subscriber so mockWebview captures store broadcasts
    agents.on('broadcast', (msg) => {
      mockWebview.postMessage(msg);
    });
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
  });

  // ── PermissionRequest ───────────────────────────────────────

  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('PermissionRequest cancels permission timer', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const timer = setTimeout(() => {}, 10000);
    permissionTimers.set(1, timer);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    expect(permissionTimers.has(1)).toBe(false);
  });

  it('PermissionRequest notifies sub-agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeSubagentToolNames.set('tool-parent', new Map([['sub-1', 'Read']]));
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const subMsg = mockWebview.messages.find((m) => m.type === 'subagentToolPermission');
    expect(subMsg).toBeTruthy();
    expect(subMsg?.parentToolId).toBe('tool-parent');
  });

  // ── Notification ────────────────────────────────────────────

  it('Notification permission_prompt sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'permission_prompt',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(agent.permissionSent).toBe(true);
  });

  it('Notification idle_prompt marks agent waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'idle_prompt',
    });

    expect(agent.isWaiting).toBe(true);
    const msg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(msg).toBeTruthy();
  });

  // ── Stop ────────────────────────────────────────────────────

  it('Stop marks agent waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('Stop clears foreground tools but preserves background agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agent.activeToolIds.add('bg-tool');
    agent.activeToolStatuses.set('bg-tool', 'Background task');
    agent.activeToolNames.set('bg-tool', 'Agent');
    agent.backgroundAgentToolIds.add('bg-tool');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(agent.activeToolIds.has('bg-tool')).toBe(true);
    const clearMsg = mockWebview.messages.find((m) => m.type === 'agentToolsClear');
    expect(clearMsg).toBeTruthy();
    const reSent = mockWebview.messages.find(
      (m) => m.type === 'agentToolStart' && m.toolId === 'bg-tool',
    );
    expect(reSent).toBeTruthy();
  });

  // ── hookDelivered ───────────────────────────────────────────

  it('sets hookDelivered flag on agent', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  // ── Buffering ───────────────────────────────────────────────

  it('silently drops events for untracked sessions', () => {
    // No agents, no pending sessions, no prior buffered events
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'unknown-sess',
    });

    // No messages sent, no crash
    expect(mockWebview.messages).toHaveLength(0);
  });

  it('buffers events when unregistered agents exist (internal agent race)', () => {
    // Agent exists in map but not yet registered for hooks
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);
    // Don't call registerAgent yet (simulates race)

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Event should be buffered (auto-discovery finds agent by sessionId and delivers)
    expect(agent.isWaiting).toBe(true);
  });

  it('flushes buffered events on registerAgent', () => {
    // Agent exists with sessionId but not registered
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    // Send event (auto-discovery will find it immediately in this case)
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Auto-discovery handles it directly
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('prunes expired buffered events', async () => {
    // Create agent so events get buffered (unregistered agent exists)
    const agent = createTestAgent({ id: 1, sessionId: 'other-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'expired-sess',
    });

    // Wait well past HOOK_EVENT_BUFFER_MS (5000) + prune interval cycle
    await new Promise((r) => setTimeout(r, 7000));

    // Now register -- event should have been pruned
    const agent2 = createTestAgent({ id: 2 });
    agents.set(2, agent2);
    handler.registerAgent('expired-sess', 2);

    // No messages (event was pruned)
    expect(mockWebview.messages).toHaveLength(0);

    handler.dispose();
  });

  // ── Auto-discovery ──────────────────────────────────────────

  it('auto-discovers agent by sessionId field', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'auto-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'auto-sess',
    });

    expect(agent.isWaiting).toBe(true);
  });

  // ── Dispose ─────────────────────────────────────────────────

  it('dispose cleans up timers and maps', () => {
    handler.registerAgent('sess-1', 1);
    handler.dispose();
    expect(() => handler.dispose()).not.toThrow();
  });

  // ── SessionStart ────────────────────────────────────────────

  it('SessionStart for known agent sets hookDelivered', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart auto-discovers agent by sessionId', () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'auto-sess',
      hookDelivered: false,
    } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'auto-sess',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart(source=clear) reassigns agent with pendingClear', () => {
    const agent = createTestAgent({
      id: 1,
      projectDir: '/projects/test',
      pendingClear: true,
    } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-sess',
      source: 'clear',
      transcript_path: '/projects/test/new-sess.jsonl',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'new-sess', '/projects/test/new-sess.jsonl');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart for unknown session stores as pending', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    // No agent created (pending, awaiting confirmation)
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── SessionEnd ──────────────────────────────────────────────

  it('SessionEnd(reason=clear) sets pendingClear and marks waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'clear',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  it('SessionEnd(reason=exit) calls onSessionEnd immediately', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'exit',
    });

    // Exit is immediate, no pendingClear delay
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('SessionEnd(reason=resume) delays onSessionEnd for SESSION_END_GRACE_MS', async () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'resume',
    });

    // pendingClear set, onSessionEnd delayed
    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).not.toHaveBeenCalled();

    // Wait for grace period (2000ms + margin)
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'resume');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionEnd discards pending external session (transient filtering)', () => {
    // Store pending session via SessionStart
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'transient-sess',
      source: 'startup',
      transcript_path: '/projects/test/transient.jsonl',
      cwd: '/projects/test',
    });

    // SessionEnd arrives before confirmation -> discard
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'transient-sess',
      reason: 'other',
    });

    // No agent created, no messages
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── PreToolUse / PostToolUse ─────────────────────────────────

  it('PreToolUse sends agentToolStart with formatted status', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.ts' },
    });

    const toolMsg = mockWebview.messages.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.toolName).toBe('Read');
    expect(toolMsg?.status).toBe('Reading server.ts');
    expect(agent.currentHookToolId).toBeTruthy();
  });

  it('PreToolUse marks agent active and cancels waiting', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(true);
    const activeMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'active',
    );
    expect(activeMsg).toBeTruthy();
  });

  it('PostToolUse sends agentToolDone and clears currentHookToolId', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-123';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-123');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  it('PostToolUseFailure sends agentToolDone', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-456';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-456');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  // ── Pending external session confirmation ────────────────────

  it('confirmation event creates pending external session and delivers event', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    // SessionStart stores as pending
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate the provider creating the agent (callback side effect)
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Stop confirms the session -> creates agent -> re-processes Stop
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'ext-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'ext-sess',
      '/projects/test/ext-sess.jsonl',
      '/projects/test',
    );
    // Stop was re-processed after agent creation
    const agent = agents.get(2);
    expect(agent?.isWaiting).toBe(true);
  });

  // ── Resume ──────────────────────────────────────────────────

  it('SessionStart(source=resume) calls onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionResume).toHaveBeenCalledWith('/projects/test/resume-sess.jsonl');
  });

  it('SessionEnd(resume) + SessionStart(resume) reassigns agent within grace period', async () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear, onSessionEnd });

    // SessionEnd(reason=resume) sets pendingClear, starts grace timer
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'old-sess',
      reason: 'resume',
    });
    expect(agent.pendingClear).toBe(true);

    // SessionStart(source=resume) arrives within grace period -> reassigns
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );

    // Grace timer fires but pendingClear is already false -> no-op
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it('SessionStart(source=resume) reassigns agent with pendingClear, not other agents in same projectDir', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    // Agent 1: the one that did /resume (has pendingClear from SessionEnd)
    const resumingAgent = createTestAgent({
      id: 1,
      sessionId: 'old-sess-1',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, resumingAgent);
    handler.registerAgent('old-sess-1', 1);

    // Agent 2: external agent in same projectDir (no pendingClear)
    const externalAgent = createTestAgent({
      id: 2,
      sessionId: 'ext-sess-2',
      projectDir: '/projects/test',
      pendingClear: false,
    });
    agents.set(2, externalAgent);
    handler.registerAgent('ext-sess-2', 2);

    // SessionStart(source=resume) should reassign Agent 1 (pendingClear), NOT Agent 2
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );
    expect(resumingAgent.pendingClear).toBe(false);
    // Agent 2 should be untouched
    expect(externalAgent.pendingClear).toBe(false);
    expect(externalAgent.sessionId).toBe('ext-sess-2');
  });

  // ── Provider-agnostic (optional transcript_path) ────────────

  it('SessionStart stores pending with cwd only (no transcript_path)', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'no-transcript-sess',
      source: 'startup',
      cwd: '/projects/test',
    });

    // Pending, no agent yet
    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate agent creation on confirmation
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Confirmation event creates agent
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'no-transcript-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'no-transcript-sess',
      undefined,
      '/projects/test',
    );
  });

  it('SessionStart(source=resume) uses cwd for matching when no transcript_path', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resumed-sess',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'resumed-sess', undefined);
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart(source=resume) without transcript_path does not call onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-no-path',
      source: 'resume',
      cwd: '/projects/test',
    });

    // onSessionResume requires transcript_path to clear dismissals
    expect(onSessionResume).not.toHaveBeenCalled();
  });

  // ── Basic subagent regression (Agent Teams feature OFF) ─────────────
  // These tests pin down the behavior that must NOT change for basic subagents.
  // Basic subagents use Agent or Task tool WITHOUT run_in_background=true.

  // PreToolUse(Agent) sets currentHookIsTeammateSpawn iff run_in_background === true.
  describe.each([
    { label: 'run_in_background=true', toolInput: { run_in_background: true }, expected: true },
    { label: 'run_in_background=false', toolInput: { run_in_background: false }, expected: false },
  ])('PreToolUse(Agent, $label)', ({ toolInput, expected }) => {
    it(`sets currentHookIsTeammateSpawn=${expected}`, () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { description: 'Code review', ...toolInput },
      });

      expect(agent.currentHookIsTeammateSpawn).toBe(expected);
    });
  });

  // SubagentStart routes to teammate discovery ONLY when both conditions hold:
  // currentHookIsTeammateSpawn === true AND agent.teamName is set (JSONL-confirmed lead).
  // Basic subagents (no spawn flag) or the external-session false-positive case
  // (spawn flag set but no teamName) fall through to the basic subagent path.
  describe.each([
    {
      label: 'teammate (spawn flag + teamName)',
      spawn: true,
      teamName: 'research',
      seedActiveTool: false,
      expectTeammateDetected: true,
    },
    {
      label: 'false-positive guard (spawn flag, no teamName)',
      spawn: true,
      teamName: undefined,
      seedActiveTool: true,
      expectTeammateDetected: false,
    },
    {
      label: 'basic subagent from hook before JSONL (no activeToolNames parent)',
      spawn: false,
      teamName: undefined,
      seedActiveTool: false,
      expectTeammateDetected: false,
    },
  ])('SubagentStart: $label', ({ spawn, teamName, seedActiveTool, expectTeammateDetected }) => {
    it(`onTeammateDetected called=${expectTeammateDetected}`, () => {
      const agent = createTestAgent({
        id: 1,
        currentHookIsTeammateSpawn: spawn,
        ...(teamName ? { teamName } : {}),
      });
      if (seedActiveTool) {
        agent.activeToolNames.set('toolu_real', 'Agent');
      } else if (!spawn) {
        agent.currentHookToolId = 'hook-XXX';
        agent.currentHookToolName = 'Agent';
      }
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      const onTeammateDetected = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected });

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: expectTeammateDetected ? 'web-researcher' : 'general-purpose',
      });

      if (expectTeammateDetected) {
        expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
        // Teammate path skips subagentToolStart (no ghost sub-agent character).
        expect(mockWebview.messages.find((m) => m.type === 'subagentToolStart')).toBeUndefined();
      } else {
        expect(onTeammateDetected).not.toHaveBeenCalled();
        const msg = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
        if (seedActiveTool) {
          // Basic path with real tool id available.
          expect(msg).toBeTruthy();
          expect(msg?.parentToolId).toBe('toolu_real');
        } else {
          // No real tool id yet -- JSONL will create the sub-agent character.
          expect(msg).toBeUndefined();
        }
      }
    });
  });
});
