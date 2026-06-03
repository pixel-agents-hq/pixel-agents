import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

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
  };
}

describe('transcriptParser: session name (custom-title records)', () => {
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    store = new AgentStateStore();
    store.set(1, createTestAgent());
    broadcasts = [];
    store.on('broadcast', (msg) => broadcasts.push(msg as Record<string, unknown>));
    waitingTimers = new Map();
    permissionTimers = new Map();
  });

  function process(line: string): void {
    processTranscriptLine(1, line, store, waitingTimers, permissionTimers);
  }

  it('sets sessionName and broadcasts agentSessionName on custom-title', () => {
    process(JSON.stringify({ type: 'custom-title', customTitle: 'My Session' }));
    expect(store.get(1)?.sessionName).toBe('My Session');
    expect(broadcasts).toContainEqual({ type: 'agentSessionName', id: 1, name: 'My Session' });
  });

  it('does not re-broadcast an unchanged title', () => {
    process(JSON.stringify({ type: 'custom-title', customTitle: 'Same' }));
    process(JSON.stringify({ type: 'custom-title', customTitle: 'Same' }));
    const nameMsgs = broadcasts.filter((m) => m.type === 'agentSessionName');
    expect(nameMsgs).toHaveLength(1);
  });

  it('broadcasts again when the title changes (rename)', () => {
    process(JSON.stringify({ type: 'custom-title', customTitle: 'First' }));
    process(JSON.stringify({ type: 'custom-title', customTitle: 'Second' }));
    expect(store.get(1)?.sessionName).toBe('Second');
    const nameMsgs = broadcasts.filter((m) => m.type === 'agentSessionName');
    expect(nameMsgs).toHaveLength(2);
  });

  it('ignores empty or non-string titles', () => {
    process(JSON.stringify({ type: 'custom-title', customTitle: '   ' }));
    process(JSON.stringify({ type: 'custom-title', customTitle: 42 }));
    process(JSON.stringify({ type: 'custom-title' }));
    expect(store.get(1)?.sessionName).toBeUndefined();
    expect(broadcasts.filter((m) => m.type === 'agentSessionName')).toHaveLength(0);
  });

  it('trims surrounding whitespace', () => {
    process(JSON.stringify({ type: 'custom-title', customTitle: '  Spaced Out  ' }));
    expect(store.get(1)?.sessionName).toBe('Spaced Out');
  });

  it('is a no-op for unknown agent ids', () => {
    expect(() =>
      processTranscriptLine(
        99,
        JSON.stringify({ type: 'custom-title', customTitle: 'X' }),
        store,
        waitingTimers,
        permissionTimers,
      ),
    ).not.toThrow();
    expect(broadcasts.filter((m) => m.type === 'agentSessionName')).toHaveLength(0);
  });
});
