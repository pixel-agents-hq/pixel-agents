import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { OPENCLAW_SUBAGENT_INACTIVITY_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  formatOpenClawToolStatus,
  normalizeOpenClawHookEvent,
} from '../src/providers/hook/openclaw/openclaw.js';
import {
  hookProviderCapabilities,
  hookProviders,
  openClawProvider,
} from '../src/providers/index.js';

describe('openClawProvider', () => {
  it('offers local installation only for a configured OpenClaw profile', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-openclaw-offer-'));
    const config = path.join(directory, 'openclaw.json');
    vi.stubEnv('OPENCLAW_CONFIG_PATH', config);
    try {
      expect(await openClawProvider.shouldOfferHooks?.()).toBe(false);
      fs.writeFileSync(config, '{}');
      expect(await openClawProvider.shouldOfferHooks?.()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('advertises both providers without removing the original tool taxonomy', () => {
    const caps = hookProviderCapabilities();
    for (const provider of [claudeProvider, openClawProvider]) {
      for (const name of provider.readingTools) expect(caps.readingTools).toContain(name);
      for (const name of provider.subagentToolNames) expect(caps.subagentToolNames).toContain(name);
    }
    expect(new Set(caps.readingTools).size).toBe(caps.readingTools.length);
    expect(new Set(caps.subagentToolNames).size).toBe(caps.subagentToolNames.length);
  });

  it('registers as a protocol-v1 hook provider', () => {
    expect(openClawProvider.kind).toBe('hook');
    expect(openClawProvider.id).toBe('openclaw');
    expect(openClawProvider.displayName).toBe('OpenClaw');
    expect(openClawProvider.protocolVersion).toBe(1);
    expect(hookProviders).toContain(openClawProvider);
    expect(openClawProvider.subagentToolNames.has('sessions_spawn')).toBe(true);
    expect(openClawProvider.subagentToolNames.has('spawn_agent')).toBe(true);
  });

  it('rejects payloads without both an event and session id', () => {
    expect(normalizeOpenClawHookEvent({ event: 'turn_end' })).toBeNull();
    expect(normalizeOpenClawHookEvent({ session_id: 'session' })).toBeNull();
  });

  it('normalizes a hooks-only session lifecycle', () => {
    expect(
      normalizeOpenClawHookEvent({
        event: 'session_start',
        session_id: 'session',
        source: 'openclaw',
        cwd: '/workspace',
      }),
    ).toEqual({
      sessionId: 'session',
      event: { kind: 'sessionStart', source: 'openclaw', cwd: '/workspace' },
    });
    expect(
      normalizeOpenClawHookEvent({
        event: 'session_end',
        session_id: 'session',
        reason: 'shutdown',
      }),
    ).toEqual({
      sessionId: 'session',
      event: { kind: 'sessionEnd', reason: 'shutdown' },
    });
  });

  it('normalizes tool events without forwarding params or results', () => {
    expect(
      normalizeOpenClawHookEvent({
        event: 'tool_start',
        session_id: 'session',
        tool_id: 'tool-1',
        tool_name: 'exec',
        params: { command: 'secret command' },
      }),
    ).toEqual({
      sessionId: 'session',
      event: { kind: 'toolStart', toolId: 'tool-1', toolName: 'exec' },
    });
    expect(
      normalizeOpenClawHookEvent({
        event: 'tool_end',
        session_id: 'session',
        tool_id: 'tool-1',
        result: 'secret output',
      }),
    ).toEqual({ sessionId: 'session', event: { kind: 'toolEnd', toolId: 'tool-1' } });
  });

  it('uses content-free tool status labels', () => {
    expect(formatOpenClawToolStatus('exec')).toBe('Running a command');
    expect(formatOpenClawToolStatus('apply_patch')).toBe('Editing files');
    expect(formatOpenClawToolStatus('custom_tool')).toBe('Using custom_tool');
  });
});

describe('AgentRuntime OpenClaw routing', () => {
  let runtime: AgentRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    vi.useRealTimers();
  });

  it('expires only explicitly identified children at two minutes and re-adopts later activity', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    const start = (sid: string, extra = {}) =>
      runtime!.handleHookEvent('openclaw', {
        event: 'session_start',
        session_id: sid,
        cwd: '/workspace',
        ...extra,
      });
    start('normal', { display_name: 'Normal · subtask', is_subagent: false });
    start('legacy', { display_name: 'Legacy · subtask' });
    start('child', { display_name: 'Avery · subtask', is_subagent: true });
    const child = [...store.values()].find((a) => a.sessionId === 'child')!;
    // Parent activity must not renew a child's independent lease.
    vi.advanceTimersByTime(OPENCLAW_SUBAGENT_INACTIVITY_MS - 1);
    start('normal', { is_subagent: false });
    expect(store.has(child.id)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.has(child.id)).toBe(false);
    expect([...store.values()].map((a) => a.sessionId).sort()).toEqual(['legacy', 'normal']);
    vi.advanceTimersByTime(10 * OPENCLAW_SUBAGENT_INACTIVITY_MS);
    expect(store.size).toBe(2);
    start('child', { is_subagent: true });
    expect(store.size).toBe(3);
    expect([...store.values()].find((a) => a.sessionId === 'child')!.id).not.toBe(child.id);
  });

  it('renews child leases on model and tool activity and cleans timers on end/dispose', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    const start = {
      event: 'session_start',
      session_id: 'child',
      cwd: '/workspace',
      is_subagent: true,
    };
    runtime.handleHookEvent('openclaw', start);
    vi.advanceTimersByTime(90_000);
    runtime.handleHookEvent('openclaw', {
      event: 'tool_start',
      session_id: 'child',
      tool_id: 'a',
      tool_name: 'exec',
    });
    vi.advanceTimersByTime(90_000);
    expect(store.size).toBe(1);
    runtime.handleHookEvent('openclaw', { event: 'tool_end', session_id: 'child', tool_id: 'a' });
    vi.advanceTimersByTime(90_000);
    expect(store.size).toBe(1);
    runtime.handleHookEvent('openclaw', start);
    vi.advanceTimersByTime(OPENCLAW_SUBAGENT_INACTIVITY_MS - 1);
    expect(store.size).toBe(1);
    runtime.handleHookEvent('openclaw', { event: 'session_end', session_id: 'child' });
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    runtime.handleHookEvent('openclaw', start);
    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a silent child even if its last tool never finished, without expiring normal agents', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    for (const [sid, child] of [
      ['child', true],
      ['normal', false],
    ] as const) {
      runtime.handleHookEvent('openclaw', {
        event: 'session_start',
        session_id: sid,
        cwd: '/workspace',
        is_subagent: child,
      });
      runtime.handleHookEvent('openclaw', {
        event: 'tool_start',
        session_id: sid,
        tool_id: 'a',
        tool_name: 'exec',
      });
    }
    vi.advanceTimersByTime(OPENCLAW_SUBAGENT_INACTIVITY_MS);
    expect([...store.values()].map((a) => a.sessionId)).toEqual(['normal']);
  });

  it('shows text-only turns immediately, survives stale checks, and resumes the same character', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    runtime.startStaleCheck();
    const start = {
      event: 'session_start',
      session_id: 'reused',
      cwd: '/remote/workspace',
      display_name: 'Friendly OpenClaw Agent',
    };
    runtime.handleHookEvent('openclaw', start);
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.agentName).toBe('Friendly OpenClaw Agent');
    expect(messages).toContainEqual({
      type: 'agentTeamInfo',
      id: agent.id,
      agentName: 'Friendly OpenClaw Agent',
    });
    expect(messages).toContainEqual({ type: 'agentStatus', id: agent.id, status: 'active' });
    runtime.handleHookEvent('openclaw', { event: 'turn_end', session_id: 'reused' });
    expect(agent.isWaiting).toBe(true);
    vi.advanceTimersByTime(90_000);
    expect(store.get(agent.id)).toBe(agent);
    runtime.handleHookEvent('openclaw', start);
    expect(store.size).toBe(1);
    expect(agent.isWaiting).toBe(false);
    runtime.handleHookEvent('openclaw', { event: 'session_end', session_id: 'reused' });
    expect(store.size).toBe(0);
    runtime.handleHookEvent('openclaw', start);
    expect(store.size).toBe(1);
  });

  it('recovers a stale mapping after removal and retains workspace restrictions', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.trackHookWorkspace('/allowed');
    runtime.handleHookEvent('openclaw', {
      event: 'session_start',
      session_id: 'blocked',
      cwd: '/blocked',
    });
    expect(store.size).toBe(0);
    const start = { event: 'session_start', session_id: 'recover', cwd: '/allowed' };
    runtime.handleHookEvent('openclaw', start);
    const id = [...store.values()][0].id;
    runtime.removeAgent(id);
    runtime.handleHookEvent('openclaw', start);
    expect(store.size).toBe(1);
    expect([...store.values()][0].id).not.toBe(id);
  });

  it('creates and animates a hooks-only OpenClaw agent in a tracked workspace', () => {
    const store = new AgentStateStore();
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    const workspace = path.join(os.tmpdir(), 'pixel-agents-openclaw-workspace');
    runtime.trackHookWorkspace(workspace);

    runtime.handleHookEvent('openclaw', {
      event: 'session_start',
      session_id: 'openclaw-session',
      cwd: workspace,
    });
    runtime.handleHookEvent('openclaw', {
      event: 'tool_start',
      session_id: 'openclaw-session',
      tool_id: 'tool-1',
      tool_name: 'exec',
    });

    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.providerId).toBe('openclaw');
    expect(agent.hooksOnly).toBe(true);
    expect(agent.activeToolIds.has('tool-1')).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', toolId: 'tool-1', toolName: 'exec' }),
    );

    runtime.handleHookEvent('openclaw', {
      event: 'tool_end',
      session_id: 'openclaw-session',
      tool_id: 'tool-1',
    });
    expect(agent.activeToolIds.has('tool-1')).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolDone', toolId: 'tool-1' }),
    );
    expect(messages).toContainEqual({ type: 'agentToolsClear', id: agent.id });
    expect(agent.isWaiting).toBe(false);
  });

  it('does not dispatch OpenClaw events through the Claude provider', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    runtime.handleHookEvent('unknown-provider', {
      event: 'session_start',
      session_id: 'unknown',
      cwd: '/workspace',
    });
    expect(store.size).toBe(0);
  });

  it('does not apply OpenClaw tool cleanup to a Claude hooks-only approval', () => {
    const store = new AgentStateStore();
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    const session = { session_id: 'claude-hooks-only', cwd: '/test' };
    runtime.handleHookEvent('claude', { ...session, hook_event_name: 'SessionStart' });
    runtime.handleHookEvent('claude', {
      ...session,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    });
    expect(store.size).toBe(1);
    runtime.handleHookEvent('claude', { ...session, hook_event_name: 'PermissionRequest' });
    const checkpoint = messages.length;
    runtime.handleHookEvent('claude', { ...session, hook_event_name: 'PostToolUse' });
    expect(messages.slice(checkpoint).some((message) => message.type === 'agentToolDone')).toBe(
      true,
    );
    expect(messages.slice(checkpoint).some((message) => message.type === 'agentToolsClear')).toBe(
      false,
    );
  });
});
