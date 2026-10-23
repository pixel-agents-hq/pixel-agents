import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
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
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function createMockAdapter(initial: PersistedAgent[] = []): StateAdapter & {
  saved: PersistedAgent[][];
} {
  let current = initial;
  const saved: PersistedAgent[][] = [];
  return {
    saved,
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
      saved.push(agents);
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

/**
 * Hooks-only characters must survive a server restart.
 *
 * restoreExternalAgents gated every record on its jsonlFile existing —
 * correct for transcript-watched agents (a deleted transcript means the
 * session was cleaned up), but a hooks-only agent (provider pushes, no
 * transcript the office reads: Hermes sessions, hooks-only external Claude
 * adoptions) has no transcript to pass that gate and vanished on every
 * restart. The flag is persisted, the gate is skipped for flagged records,
 * and no file watcher is started for them — their liveness signal is the
 * push stream, and events route again the moment the session mapping is
 * re-registered.
 */
describe('AgentRuntime -- hooks-only agents survive restart', () => {
  let tmpDir: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-ho-'));
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores a hooks-only agent with no transcript and re-routes its events', () => {
    const persisted: PersistedAgent[] = [
      {
        id: 9,
        sessionId: 'sess-hooks-only',
        terminalName: '',
        isExternal: true,
        hooksOnly: true,
        jsonlFile: '',
        projectDir: tmpDir,
        palette: 2,
        hueShift: 0,
      },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    const agent = store.get(9);
    expect(agent).toBeDefined();
    expect(agent?.hooksOnly).toBe(true);
    expect(agent?.sessionId).toBe('sess-hooks-only');

    // The session→agent mapping is back: a provider push routes to it.
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-hooks-only',
      tool_name: 'read_file',
      tool_input: { path: `${tmpDir}/x.md` },
    });
    expect(store.get(9)?.currentHookToolId).toBeTruthy();
  });

  it('still prunes a NON-hooks-only record whose transcript was deleted', () => {
    const gone = path.join(tmpDir, 'deleted-session.jsonl');
    const persisted: PersistedAgent[] = [
      {
        id: 3,
        sessionId: 'sess-gone',
        terminalName: '',
        isExternal: true,
        jsonlFile: gone, // never created
        projectDir: tmpDir,
      },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    expect(store.has(3)).toBe(false);
  });

  it('persist() writes the hooksOnly flag onto the record restore reads', () => {
    const store = new AgentStateStore();
    const adapter = createMockAdapter();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, claudeProvider);
    store.set(11, createTestAgent({ id: 11, sessionId: 'sess-p', hooksOnly: true }));

    store.persist();

    const last = adapter.saved[adapter.saved.length - 1];
    expect(last.find((a) => a.id === 11)?.hooksOnly).toBe(true);
  });
});
