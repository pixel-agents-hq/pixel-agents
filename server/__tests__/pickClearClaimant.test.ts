import { beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts does `import * as vscode from 'vscode'` at module load; the 'vscode'
// package only resolves inside the extension host. Stub the two APIs fileWatcher
// touches at runtime so the module loads under vitest.
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import { AgentStateStore } from '../src/agentStateStore.js';
import { CLEAR_IDLE_THRESHOLD_MS } from '../src/constants.js';
import { pickClearClaimant } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: { name: 'term' },
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
    linesProcessed: 10,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  } as AgentState;
}

/**
 * #251 — with two sessions in the same project dir, the /clear transcript must
 * be claimed by the agent whose activity stopped at the file's creation time,
 * not by whichever agent happens to be polling (formerly: the active terminal).
 */
describe('pickClearClaimant', () => {
  let agents: AgentStateStore;
  const now = 1_000_000_000;
  const idle = CLEAR_IDLE_THRESHOLD_MS + 5_000;

  beforeEach(() => {
    agents = new AgentStateStore();
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });

  it('single agent claims its own /clear file', () => {
    agents.set(1, createTestAgent({ id: 1, lastDataAt: now - idle }));
    expect(pickClearClaimant(agents, 1, now - idle)).toBe(1);
  });

  it('the agent whose data stopped at file creation wins over the polling agent', () => {
    // Agent 1 (polling, e.g. active terminal) went idle long before the /clear;
    // agent 2 stopped writing right when the new file appeared.
    const fileBirth = now - idle;
    agents.set(1, createTestAgent({ id: 1, sessionId: 'a', lastDataAt: fileBirth - 60_000 }));
    agents.set(2, createTestAgent({ id: 2, sessionId: 'b', lastDataAt: fileBirth - 100 }));
    expect(pickClearClaimant(agents, 1, fileBirth)).toBe(2);
  });

  it('polling agent keeps the file when it is the best match', () => {
    const fileBirth = now - idle;
    agents.set(1, createTestAgent({ id: 1, sessionId: 'a', lastDataAt: fileBirth - 100 }));
    agents.set(2, createTestAgent({ id: 2, sessionId: 'b', lastDataAt: fileBirth - 60_000 }));
    expect(pickClearClaimant(agents, 1, fileBirth)).toBe(1);
  });

  it('busy (non-idle) agents are not candidates even if closer to file birth', () => {
    const fileBirth = now - idle;
    agents.set(1, createTestAgent({ id: 1, sessionId: 'a', lastDataAt: fileBirth - 60_000 }));
    // Agent 2 is still streaming data — it cannot be the one that ran /clear.
    agents.set(2, createTestAgent({ id: 2, sessionId: 'b', lastDataAt: now - 1_000 }));
    expect(pickClearClaimant(agents, 1, fileBirth)).toBe(1);
  });

  it('external, hook-driven, and terminal-less agents are not candidates', () => {
    const fileBirth = now - idle;
    agents.set(1, createTestAgent({ id: 1, sessionId: 'a', lastDataAt: fileBirth - 60_000 }));
    agents.set(
      2,
      createTestAgent({ id: 2, sessionId: 'b', lastDataAt: fileBirth, isExternal: true }),
    );
    agents.set(
      3,
      createTestAgent({ id: 3, sessionId: 'c', lastDataAt: fileBirth, hookDelivered: true }),
    );
    agents.set(
      4,
      createTestAgent({ id: 4, sessionId: 'd', lastDataAt: fileBirth, terminalRef: undefined }),
    );
    expect(pickClearClaimant(agents, 1, fileBirth)).toBe(1);
  });
});
