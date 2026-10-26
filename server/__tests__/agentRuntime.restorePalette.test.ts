import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
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
    backgroundSpawns: new Map(),
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
    loadCardOrder: () => [],
    saveCardOrder: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

/**
 * Restored agents must keep their palette/repeat across server restarts.
 *
 * These tests use a mock adapter (mirror of backgroundAgents.test.ts's
 * fakeAdapter) for the in-memory PersistedAgent[] the adapter hands back.
 * Disk is touched only for the existence gate: restoreExternalAgents skips
 * agents whose jsonlFile doesn't exist, so each test creates one empty file.
 * No FileStateAdapter, no HOME/USERPROFILE override, no state-file I/O.
 */
describe('AgentRuntime -- restore preserves palette/repeat', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-pal-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
  });

  afterEach(() => {
    // Dispose BEFORE cleaning the tmp dir: AgentRuntime.dispose() calls
    // removeAgent() for every tracked agent, which calls store.persist();
    // if the runtime is disposed mid-test (between a persist and a fresh
    // adapter's load) it can clobber in-memory state.
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restoreExternalAgents keeps palette/repeat from the persisted record', () => {
    const persisted: PersistedAgent[] = [
      {
        id: 7,
        sessionId: 'sess-restore',
        terminalName: '',
        isExternal: true,
        jsonlFile: jsonlPath,
        projectDir: tmpDir,
        palette: 3,
        repeat: 2,
      },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    const agent = store.get(7);
    expect(agent).toBeDefined();
    expect(agent?.palette).toBe(3);
    expect(agent?.repeat).toBe(2);
  });

  it("reads an older record's look in degrees as a repeat", () => {
    const persisted: PersistedAgent[] = [
      {
        id: 8,
        sessionId: 'sess-legacy',
        terminalName: '',
        isExternal: true,
        jsonlFile: jsonlPath,
        projectDir: tmpDir,
        palette: 2,
        hueShift: 137,
      },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    expect(store.get(8)?.repeat).toBe(1);
  });

  it("reads a clothesHue record's colour as a repeat, and its own colours as none", () => {
    const record = (id: number, clothesHue: number): PersistedAgent => ({
      id,
      sessionId: `sess-${id}`,
      terminalName: '',
      isExternal: true,
      jsonlFile: jsonlPath,
      projectDir: tmpDir,
      palette: 2,
      clothesHue,
    });
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter([record(10, 360), record(11, 0)]));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    expect(store.get(10)?.repeat).toBe(1);
    expect(store.get(11)?.repeat).toBe(0);
  });

  it('persist() writes palette/repeat onto the record that restoreExternalAgents copies back', () => {
    // Phase 1: persist an agent with palette/repeat and capture the
    // record the adapter received.
    const storeA = new AgentStateStore();
    const adapterA = createMockAdapter();
    storeA.setAdapter(adapterA);
    runtime = new AgentRuntime(storeA, claudeProvider);
    storeA.set(
      42,
      createTestAgent({
        id: 42,
        sessionId: 'sess-rt',
        jsonlFile: jsonlPath,
        projectDir: tmpDir,
        palette: 5,
        repeat: 3,
      }),
    );
    storeA.persist();

    // Capture the record our explicit persist() wrote BEFORE disposing
    // the runtime: dispose() walks the store and persists removals, which
    // would otherwise clobber the captured record or push an empty entry
    // onto `saved`.
    expect(adapterA.saved.length).toBeGreaterThanOrEqual(1);
    const persisted = adapterA.saved[0];
    expect(persisted[0].palette).toBe(5);
    expect(persisted[0].repeat).toBe(3);

    runtime.dispose();
    runtime = undefined;

    // Phase 2: a fresh store + runtime restore from the record phase 1
    // wrote. The new adapter hands back exactly what phase 1 persisted.
    const storeB = new AgentStateStore();
    storeB.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(storeB, claudeProvider);
    runtime.restoreExternalAgents();

    const restored = storeB.get(42);
    expect(restored).toBeDefined();
    expect(restored?.palette).toBe(5);
    expect(restored?.repeat).toBe(3);
  });

  it('assigns a fresh palette when the persisted record has no palette', () => {
    const persisted: PersistedAgent[] = [
      {
        id: 9,
        sessionId: 'sess-fresh',
        terminalName: '',
        isExternal: true,
        jsonlFile: jsonlPath,
        projectDir: tmpDir,
        // palette/repeat intentionally omitted
      },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    const agent = store.get(9);
    expect(agent).toBeDefined();
    // assignPaletteIfNeeded fills in [0, 6) with repeat 0 on an empty
    // store (first round). Assert "set to a valid value" rather than
    // re-deriving the exact algorithm.
    expect(agent?.palette).toBeGreaterThanOrEqual(0);
    expect(agent?.palette).toBeLessThan(6);
    expect(agent?.repeat).toBe(0);
  });
});
