import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { ORCA_EVENT } from '../src/providers/hook/orca/constants.js';
import { claudeProvider, orcaProvider } from '../src/providers/index.js';

/**
 * M4 — Orca push + adoption. Drives the real runtime path an Orca event takes:
 * POST /api/hooks/orca -> runtime.handleHookEvent -> hookEventHandler ->
 * orcaProvider.normalizeHookEvent -> pending/confirm -> onExternalSessionDetected
 * -> adoptExternalSessionFromHook (hooks-only) -> AgentStateStore.
 */
const PTYID = 'uuid-1::/home/han/orca/new-game@@c1';

describe('Orca adoption (M4)', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.registerProvider(orcaProvider);
    runtime.orcaEnabled.current = true; // enable Orca adoption (default is off / opt-in)
  });

  afterEach(() => {
    runtime.dispose();
  });

  const agents = () => [...store.values()];

  it('session.start alone does not create an agent (pending until confirmed)', () => {
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'codex',
    });
    expect(agents()).toHaveLength(0);
  });

  it('a confirmation event adopts the ptyId as a hooks-only agent tagged by CLI type', () => {
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'codex',
    });
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'codex',
      tool: { name: 'Read', input: { file_path: '/x/foo.ts' } },
    });

    const list = agents();
    expect(list).toHaveLength(1);
    const a = list[0];
    expect(a.agentType).toBe('codex'); // → M2 broadcasts agentProviderInfo → type badge
    expect(a.hooksOnly).toBe(true);
    expect(a.jsonlFile).toBe('');
    expect(a.projectDir).toBe('/home/han/orca/new-game');
    expect(a.folderName).toBe('new-game');
    expect(a.sessionId).toBe(PTYID);
    expect(a.hookDelivered).toBe(true);
  });

  it('adopts even in an untracked workspace (push-based always-adopt)', () => {
    const pty = 'uuid-2::/totally/untracked/ws@@d2';
    runtime.handleHookEvent('orca', {
      session_id: pty,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'gemini',
    });
    runtime.handleHookEvent('orca', {
      session_id: pty,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'gemini',
      tool: { name: 'Grep', input: {} },
    });

    const list = agents();
    expect(list).toHaveLength(1);
    expect(list[0].agentType).toBe('gemini');
    expect(list[0].folderName).toBe('ws');
  });

  it('marks the adopted agent active after the confirming tool.call', () => {
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'cursor',
    });
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'cursor',
      tool: { name: 'Read', input: {} },
    });

    const a = agents()[0];
    expect(a.isWaiting).toBe(false);
    expect(a.hadToolsInTurn).toBe(true);
  });

  it('idle state confirms adoption and marks the agent waiting', () => {
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'droid',
    });
    // A text-only turn: no tools, then goes idle (state=idle) — the idle event confirms.
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.ASSISTANT_MESSAGE,
      agent_type: 'droid',
      state: 'idle',
    });

    const list = agents();
    expect(list).toHaveLength(1);
    expect(list[0].agentType).toBe('droid');
    expect(list[0].isWaiting).toBe(true);
  });

  it('a permission.request (decision gate) raises the permission bubble on the adopted agent', () => {
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => messages.push(m));

    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'devin',
    });
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'devin',
      tool: { name: 'Bash', input: { command: 'rm -rf build' } },
    });
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.PERMISSION_REQUEST,
      agent_type: 'devin',
    });

    const a = agents()[0];
    expect(a.permissionSent).toBe(true);
    expect(messages.some((m) => m.type === 'agentToolPermission' && m.id === a.id)).toBe(true);
  });

  it('does not adopt when the Orca integration setting is off (orcaEnabled=false)', () => {
    runtime.orcaEnabled.current = false;
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      agent_type: 'codex',
    });
    runtime.handleHookEvent('orca', {
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'codex',
      tool: { name: 'Read', input: {} },
    });
    expect(agents()).toHaveLength(0);
  });
});
