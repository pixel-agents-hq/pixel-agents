import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  formatOpenClawToolStatus,
  normalizeOpenClawHookEvent,
} from '../src/providers/hook/openclaw/openclaw.js';
import { hookProviders, openClawProvider } from '../src/providers/index.js';

describe('openClawProvider', () => {
  it('registers as a protocol-v1 hook provider', () => {
    expect(openClawProvider.kind).toBe('hook');
    expect(openClawProvider.id).toBe('openclaw');
    expect(openClawProvider.displayName).toBe('OpenClaw');
    expect(openClawProvider.protocolVersion).toBe(1);
    expect(hookProviders).toContain(openClawProvider);
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

  it('shows text-only turns immediately, survives stale checks, and resumes the same character', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider, hookProviders);
    runtime.watchAllSessions.current = true;
    runtime.startStaleCheck();
    const start = { event: 'session_start', session_id: 'reused', cwd: '/remote/workspace' };
    runtime.handleHookEvent('openclaw', start);
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
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
});
