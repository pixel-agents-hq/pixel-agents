import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

describe('AgentRuntime -- session name refresh', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    runtime?.dispose();
  });

  function makeAgent(id: number, sessionId: string, leadAgentId?: number): AgentState {
    return {
      id,
      sessionId,
      isExternal: false,
      projectDir: '',
      jsonlFile: '',
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
      inputTokens: 0,
      outputTokens: 0,
      leadAgentId,
    };
  }

  /** Invoke the private periodic refresh once (a single interval tick). */
  function tick(): void {
    (runtime as unknown as { refreshSessionNames(): void }).refreshSessionNames();
  }

  it('broadcasts agentSessionNameChanged when a name appears, and stores it', () => {
    store = new AgentStateStore();
    let name: string | undefined;
    const provider = { ...claudeProvider, getSessionName: () => name };
    runtime = new AgentRuntime(store, provider);
    store.set(1, makeAgent(1, 'sess-1'));

    const events: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => events.push(m));

    // No name yet -> immediate resolve fires nothing (undefined unchanged).
    runtime.startSessionNameRefresh();
    expect(events).toHaveLength(0);
    expect(store.get(1)?.sessionName).toBeUndefined();

    // Name resolves -> next tick broadcasts and stores it.
    name = 'pixel-agents-1a';
    tick();
    expect(store.get(1)?.sessionName).toBe('pixel-agents-1a');
    expect(events).toEqual([
      { type: 'agentSessionNameChanged', id: 1, sessionName: 'pixel-agents-1a' },
    ]);

    // Unchanged name -> no duplicate broadcast.
    tick();
    expect(events).toHaveLength(1);
  });

  it('does not resolve session names for teammates (they inherit folderName)', () => {
    store = new AgentStateStore();
    const provider = { ...claudeProvider, getSessionName: () => 'lead-session' };
    runtime = new AgentRuntime(store, provider);
    store.set(2, makeAgent(2, 'lead-sess', /* leadAgentId */ 1));

    const events: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => events.push(m));

    runtime.startSessionNameRefresh();
    tick();
    expect(store.get(2)?.sessionName).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
