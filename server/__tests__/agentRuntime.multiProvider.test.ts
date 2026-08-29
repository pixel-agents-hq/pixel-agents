import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

describe('AgentRuntime multi-provider isolation', () => {
  const runtimes: AgentRuntime[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const runtime of runtimes) runtime.dispose();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    runtimes.length = 0;
    tempDirs.length = 0;
  });

  function create(): { store: AgentStateStore; runtime: AgentRuntime; cwd: string } {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, [claudeProvider, hermesProvider]);
    runtime.watchAllSessions.current = true;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-multi-provider-'));
    runtimes.push(runtime);
    tempDirs.push(cwd);
    return { store, runtime, cwd };
  }

  function adoptHermes(runtime: AgentRuntime, sessionId: string, cwd: string): void {
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'on_session_start',
      session_id: sessionId,
      cwd,
    });
  }

  it('rejects duplicate registrations and drops unknown providers', () => {
    expect(() => new AgentRuntime(new AgentStateStore(), [hermesProvider, hermesProvider])).toThrow(
      'Duplicate HookProvider id: hermes',
    );
    const { store, runtime } = create();
    runtime.handleHookEvent('not-installed', { hook_event_name: 'anything', session_id: 's1' });
    expect(store.size).toBe(0);
  });

  it('keeps the same session ID isolated across Claude and Hermes', () => {
    const { store, runtime, cwd } = create();
    const transcript = path.join(cwd, 'same-session.jsonl');
    fs.writeFileSync(transcript, '');
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'same-session',
      transcript_path: transcript,
      cwd,
    });
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'same-session' });
    adoptHermes(runtime, 'same-session', cwd);
    expect([...store.values()].map((agent) => agent.providerId).sort()).toEqual([
      'claude',
      'hermes',
    ]);
  });

  it('persists an adopted Hermes parent with its provider identity', () => {
    const { store, runtime, cwd } = create();
    let savedProviderIds: Array<string | undefined> = [];
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (agents) => {
        savedProviderIds = agents.map((agent) => agent.providerId);
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: (_key, defaultValue) => defaultValue,
      setSetting: () => {},
    });

    adoptHermes(runtime, 'persisted-hermes', cwd);

    expect([...store.values()][0]?.providerId).toBe('hermes');
    expect(savedProviderIds).toEqual(['hermes']);
  });

  it('correlates simultaneous tools exactly and accepts out-of-order completion', () => {
    const { store, runtime, cwd } = create();
    adoptHermes(runtime, 'tools', cwd);
    const agent = [...store.values()][0]!;
    for (const toolCallId of ['call-a', 'call-b']) {
      runtime.handleHookEvent('hermes', {
        hook_event_name: 'pre_tool_call',
        session_id: 'tools',
        tool_name: 'read_file',
        tool_input: { path: `${toolCallId}.ts` },
        extra: { tool_call_id: toolCallId },
      });
    }
    expect(agent.activeToolIds).toEqual(new Set(['call-a', 'call-b']));
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'post_tool_call',
      session_id: 'tools',
      extra: { tool_call_id: 'call-a' },
    });
    expect(agent.activeToolIds).toEqual(new Set(['call-b']));
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'post_tool_call',
      session_id: 'tools',
      extra: { tool_call_id: 'call-b' },
    });
    expect(agent.activeToolIds.size).toBe(0);
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'on_session_end',
      session_id: 'tools',
    });
    expect(store.has(agent.id)).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  it('keeps parent and sibling child lifecycles isolated, then finalizes the session', () => {
    const { store, runtime, cwd } = create();
    adoptHermes(runtime, 'parent', cwd);
    for (const child of ['child-a', 'child-b']) {
      runtime.handleHookEvent('hermes', {
        hook_event_name: 'subagent_start',
        session_id: 'parent',
        extra: { child_session_id: child, child_role: 'researcher' },
      });
    }
    expect([...store.values()].map((agent) => agent.sessionId).sort()).toEqual([
      'child-a',
      'child-b',
      'parent',
    ]);
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'subagent_stop',
      session_id: 'parent',
      extra: { child_session_id: 'child-a' },
    });
    expect([...store.values()].map((agent) => agent.sessionId).sort()).toEqual([
      'child-b',
      'parent',
    ]);
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'on_session_finalize',
      session_id: 'parent',
    });
    expect(store.size).toBe(0);
  });

  it('clears permission state without retaining approval command or decision data', () => {
    const { store, runtime, cwd } = create();
    adoptHermes(runtime, 'approval', cwd);
    const agent = [...store.values()][0]!;
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'pre_approval_request',
      extra: { session_key: 'approval', command: 'secret command' },
    });
    expect(agent.permissionSent).toBe(true);
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'post_approval_response',
      extra: { session_key: 'approval', decision: 'approved' },
    });
    expect(agent.permissionSent).toBe(false);
    expect(JSON.stringify(agent)).not.toContain('secret command');
    expect(JSON.stringify(agent)).not.toContain('approved');
  });

  it('unregisters a manually removed Hermes route so the live session can be adopted again', () => {
    const { store, runtime, cwd } = create();
    adoptHermes(runtime, 'reopen-session', cwd);
    const first = [...store.values()][0]!;

    runtime.removeAgent(first.id);
    expect(store.size).toBe(0);

    adoptHermes(runtime, 'reopen-session', cwd);
    const replacement = [...store.values()][0]!;
    expect(replacement.sessionId).toBe('reopen-session');
    expect(replacement.providerId).toBe('hermes');
    expect(replacement.id).not.toBe(first.id);
  });
});
