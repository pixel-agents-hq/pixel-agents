import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

/**
 * Covers the multi-provider routing patch in agentRuntime.ts: one HookEventHandler
 * per provider, sharing a single AgentStateStore/office, routed by providerId.
 */
describe('AgentRuntime -- multi-provider routing', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    runtime?.dispose();
    vi.useRealTimers();
  });

  function trackedDir(prefix: string): string {
    const dir = path.join(os.tmpdir(), `pxl-multi-${prefix}-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('drops an event from an unregistered providerId without throwing', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    expect(() =>
      runtime.handleHookEvent('some-unknown-provider', {
        hook_event_name: 'SessionStart',
        session_id: 'x',
      }),
    ).not.toThrow();
    expect(store.size).toBe(0);
  });

  // A bare SessionStart only stores a *pending* external session (guards against
  // Claude Code Extension's SessionStart+SessionEnd-with-no-activity noise, per
  // hookEventHandler.ts); it takes a second "confirmation" event on the same
  // session_id before an agent actually appears in the store. Every test below
  // sends that follow-up event deliberately, matching real hook traffic.

  it('routes Hermes and Codex sessions into the same store as distinct agents, tagged with their own providerId', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    runtime.watchAllSessions.current = true; // bypass the project-dir tracking gate for this test

    const hermesDir = trackedDir('hermes');
    const codexDir = trackedDir('codex');

    runtime.handleHookEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: 'hermes-sess-1',
      cwd: hermesDir,
    });
    runtime.handleHookEvent('hermes', { hook_event_name: 'TurnEnd', session_id: 'hermes-sess-1' });
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'codex-sess-1',
      cwd: codexDir,
    });
    runtime.handleHookEvent('codex', { hook_event_name: 'TurnEnd', session_id: 'codex-sess-1' });

    expect(store.size).toBe(2);
    const providerIds = [...store.values()].map((a) => a.providerId).sort();
    expect(providerIds).toEqual(['codex', 'hermes']);
  });

  it('duplicate SessionStart for the same providerId+session does not create a second agent', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    runtime.watchAllSessions.current = true;
    const dir = trackedDir('dup');

    runtime.handleHookEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: 'hermes-dup-1',
      cwd: dir,
    });
    runtime.handleHookEvent('hermes', { hook_event_name: 'TurnEnd', session_id: 'hermes-dup-1' });
    expect(store.size).toBe(1);

    // A second SessionStart for an already-known session_id is a no-op, not a
    // fresh pending adoption (matches Claude's "known" SessionStart branch).
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: 'hermes-dup-1',
      cwd: dir,
    });
    expect(store.size).toBe(1);
  });

  it('a Hermes toolStart/toolEnd pair does not affect a concurrent Codex agent in the same store', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    runtime.watchAllSessions.current = true;
    const hermesDir = trackedDir('hermes2');
    const codexDir = trackedDir('codex2');

    runtime.handleHookEvent('hermes', {
      hook_event_name: 'SessionStart',
      session_id: 'h-1',
      cwd: hermesDir,
    });
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'c-1',
      cwd: codexDir,
    });
    // Confirm Codex first with a no-op TurnEnd so it's adopted but has no tool activity.
    runtime.handleHookEvent('codex', { hook_event_name: 'TurnEnd', session_id: 'c-1' });
    // Confirm + drive Hermes via ExecStart (confirms the pending session AND
    // delivers the tool start in the same call -- see hookEventHandler.ts's
    // confirmPending -> re-process-this-event flow).
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'ExecStart',
      session_id: 'h-1',
      tool_id: 't1',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
    });

    const codexAgent = [...store.values()].find((a) => a.providerId === 'codex');
    const hermesAgent = [...store.values()].find((a) => a.providerId === 'hermes');
    expect(codexAgent?.hadToolsInTurn).toBe(false);
    expect(codexAgent?.currentHookToolName).toBeUndefined();
    expect(hermesAgent?.hadToolsInTurn).toBe(true);
    expect(hermesAgent?.currentHookToolName).toBe('terminal');
  });

  it('malformed events (missing fields, wrong types) are dropped, never throw, and never create an agent', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    const malformed: Array<Record<string, unknown>> = [
      {},
      { hook_event_name: 123, session_id: 'x' },
      { hook_event_name: 'SessionStart', session_id: null },
      { hook_event_name: 'ExecStart', session_id: 'x', tool_id: 42 },
    ];
    for (const event of malformed) {
      expect(() => runtime.handleHookEvent('hermes', event)).not.toThrow();
      expect(() => runtime.handleHookEvent('codex', event)).not.toThrow();
    }
    expect(store.size).toBe(0);
  });

  it('dispose() tears down every provider handler without throwing', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, [claudeProvider, hermesProvider, codexProvider]);
    expect(() => runtime.dispose()).not.toThrow();
  });
});
