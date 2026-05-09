import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

function createMockAdapter(): StateAdapter {
  return {
    loadAgents: vi.fn(() => []),
    saveAgents: vi.fn(),
    loadSeats: vi.fn(() => ({})),
    saveSeats: vi.fn(),
    getSetting: vi.fn(<T>(_k: string, d: T): T => d),
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
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
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  } as AgentState;
}

describe('AgentStateStore', () => {
  let store: AgentStateStore;

  beforeEach(() => {
    store = new AgentStateStore();
  });

  describe('CRUD operations', () => {
    it('set and get', () => {
      const agent = createTestAgent({ id: 1 });
      store.set(1, agent);
      expect(store.get(1)).toBe(agent);
    });

    it('has returns true for existing agents', () => {
      store.set(1, createTestAgent({ id: 1 }));
      expect(store.has(1)).toBe(true);
      expect(store.has(99)).toBe(false);
    });

    it('delete removes agent', () => {
      store.set(1, createTestAgent({ id: 1 }));
      expect(store.delete(1)).toBe(true);
      expect(store.has(1)).toBe(false);
      expect(store.delete(1)).toBe(false);
    });

    it('clear removes all agents', () => {
      store.set(1, createTestAgent({ id: 1 }));
      store.set(2, createTestAgent({ id: 2 }));
      store.clear();
      expect(store.size).toBe(0);
    });

    it('size tracks mutations', () => {
      expect(store.size).toBe(0);
      store.set(1, createTestAgent({ id: 1 }));
      expect(store.size).toBe(1);
      store.set(2, createTestAgent({ id: 2 }));
      expect(store.size).toBe(2);
      store.delete(1);
      expect(store.size).toBe(1);
    });
  });

  describe('iteration', () => {
    it('keys returns agent IDs', () => {
      store.set(1, createTestAgent({ id: 1 }));
      store.set(5, createTestAgent({ id: 5 }));
      expect([...store.keys()]).toEqual([1, 5]);
    });

    it('values returns agents', () => {
      const a1 = createTestAgent({ id: 1 });
      const a2 = createTestAgent({ id: 2 });
      store.set(1, a1);
      store.set(2, a2);
      expect([...store.values()]).toEqual([a1, a2]);
    });

    it('entries returns [id, agent] pairs', () => {
      const a1 = createTestAgent({ id: 1 });
      store.set(1, a1);
      expect([...store.entries()]).toEqual([[1, a1]]);
    });

    it('forEach iterates over agents', () => {
      store.set(1, createTestAgent({ id: 1 }));
      store.set(2, createTestAgent({ id: 2 }));
      const ids: number[] = [];
      store.forEach((_agent, id) => ids.push(id));
      expect(ids).toEqual([1, 2]);
    });

    it('Symbol.iterator enables for...of', () => {
      const a1 = createTestAgent({ id: 1 });
      store.set(1, a1);
      const result: Array<[number, AgentState]> = [];
      for (const entry of store) {
        result.push(entry);
      }
      expect(result).toEqual([[1, a1]]);
    });

    it('spread operator works on values', () => {
      store.set(1, createTestAgent({ id: 1 }));
      store.set(2, createTestAgent({ id: 2 }));
      const agents = [...store.values()];
      expect(agents).toHaveLength(2);
    });
  });

  describe('persistence', () => {
    it('persist calls adapter.saveAgents with correct shape', () => {
      const adapter = createMockAdapter();
      store.setAdapter(adapter);
      store.set(
        1,
        createTestAgent({
          id: 1,
          sessionId: 'sess-1',
          projectDir: '/proj',
          jsonlFile: '/proj/sess-1.jsonl',
          folderName: 'my-folder',
          teamName: 'team-a',
          agentName: undefined,
          isTeamLead: true,
        }),
      );

      store.persist();

      expect(adapter.saveAgents).toHaveBeenCalledOnce();
      const saved = (adapter.saveAgents as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as PersistedAgent[];
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe(1);
      expect(saved[0].sessionId).toBe('sess-1');
      expect(saved[0].terminalName).toBe('');
      expect(saved[0].projectDir).toBe('/proj');
      expect(saved[0].jsonlFile).toBe('/proj/sess-1.jsonl');
      expect(saved[0].folderName).toBe('my-folder');
      expect(saved[0].teamName).toBe('team-a');
      expect(saved[0].isTeamLead).toBe(true);
    });

    it('persist without adapter is a no-op', () => {
      store.set(1, createTestAgent({ id: 1 }));
      // Should not throw
      store.persist();
    });

    it('loadPersistedAgents returns data from adapter', () => {
      const adapter = createMockAdapter();
      const persisted: PersistedAgent[] = [
        { id: 1, terminalName: 'term-1', jsonlFile: '/a.jsonl', projectDir: '/proj' },
        { id: 2, terminalName: 'term-2', jsonlFile: '/b.jsonl', projectDir: '/proj' },
      ];
      (adapter.loadAgents as ReturnType<typeof vi.fn>).mockReturnValue(persisted);
      store.setAdapter(adapter);

      expect(store.loadPersistedAgents()).toBe(persisted);
    });

    it('loadPersistedAgents without adapter returns empty array', () => {
      expect(store.loadPersistedAgents()).toEqual([]);
    });
  });

  describe('adapter management', () => {
    it('setAdapter and getAdapter', () => {
      expect(store.getAdapter()).toBeUndefined();
      const adapter = createMockAdapter();
      store.setAdapter(adapter);
      expect(store.getAdapter()).toBe(adapter);
    });
  });

  describe('counter refs', () => {
    it('nextAgentId is a shared ref', () => {
      const ref = store.nextAgentId;
      expect(ref.current).toBe(1);
      ref.current = 10;
      expect(store.nextAgentId.current).toBe(10);
    });

    it('nextTerminalIndex is a shared ref', () => {
      const ref = store.nextTerminalIndex;
      expect(ref.current).toBe(1);
      ref.current = 5;
      expect(store.nextTerminalIndex.current).toBe(5);
    });
  });

  describe('events', () => {
    it('agentAdded fires on set() for new agent', () => {
      const cb = vi.fn();
      store.on('agentAdded', cb);
      const agent = createTestAgent({ id: 1 });
      store.set(1, agent);
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(1, agent);
    });

    it('agentAdded does NOT fire on set() for existing agent (overwrite)', () => {
      const cb = vi.fn();
      store.set(1, createTestAgent({ id: 1 }));
      store.on('agentAdded', cb);
      store.set(1, createTestAgent({ id: 1, sessionId: 'new-session' }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('agentRemoved fires on delete() for existing agent', () => {
      const cb = vi.fn();
      store.set(1, createTestAgent({ id: 1 }));
      store.on('agentRemoved', cb);
      store.delete(1);
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(1);
    });

    it('agentRemoved does NOT fire on delete() for non-existent agent', () => {
      const cb = vi.fn();
      store.on('agentRemoved', cb);
      store.delete(99);
      expect(cb).not.toHaveBeenCalled();
    });

    it('off() unsubscribes listener', () => {
      const cb = vi.fn();
      store.on('agentAdded', cb);
      store.off('agentAdded', cb);
      store.set(1, createTestAgent({ id: 1 }));
      expect(cb).not.toHaveBeenCalled();
    });

    it('dispose() removes all listeners', () => {
      const addCb = vi.fn();
      const removeCb = vi.fn();
      store.on('agentAdded', addCb);
      store.on('agentRemoved', removeCb);
      store.dispose();
      store.set(1, createTestAgent({ id: 1 }));
      store.delete(1);
      expect(addCb).not.toHaveBeenCalled();
      expect(removeCb).not.toHaveBeenCalled();
    });

    it('multiple listeners both fire', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      store.on('agentAdded', cb1);
      store.on('agentAdded', cb2);
      store.set(1, createTestAgent({ id: 1 }));
      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });
});
