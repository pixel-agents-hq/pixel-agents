/**
 * An agent closing itself (close_agent on yourself) is ended when its turn
 * ends — so its CLI records the turn that closed it — or after a fallback when
 * no turn end is heard; never if it left first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { SELF_CLOSE_FALLBACK_MS } from '../src/constants.js';
import { closeAfterTurn } from '../src/mcp/lifecycle.js';

describe('closeAfterTurn', () => {
  let store: AgentStateStore;
  let closed: number[];
  const close = (id: number) => closed.push(id);

  beforeEach(() => {
    vi.useFakeTimers();
    store = new AgentStateStore();
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: '/p',
        jsonlFile: '/p/s.jsonl',
        isExternal: false,
      }),
    );
    closed = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    store.dispose();
  });

  it('closes on the turn end, not on a report that the turn goes on', () => {
    closeAfterTurn(store, 1, close);
    store.setAgentStatus(1, { active: true });
    vi.advanceTimersByTime(SELF_CLOSE_FALLBACK_MS - 1);
    expect(closed).toEqual([]);
    store.setAgentStatus(1, { active: false, awaitingInput: false });
    expect(closed).toEqual([1]);
    // Once.
    store.setAgentStatus(1, { active: false, awaitingInput: false });
    vi.advanceTimersByTime(SELF_CLOSE_FALLBACK_MS);
    expect(closed).toEqual([1]);
  });

  it("ignores other agents' turns", () => {
    closeAfterTurn(store, 1, close);
    store.setAgentStatus(2, { active: false, awaitingInput: true });
    expect(closed).toEqual([]);
  });

  it('falls back to closing when no turn end is heard', () => {
    closeAfterTurn(store, 1, close);
    vi.advanceTimersByTime(SELF_CLOSE_FALLBACK_MS);
    expect(closed).toEqual([1]);
  });

  it('does nothing for an agent that left first, or once cancelled', () => {
    closeAfterTurn(store, 1, close);
    store.delete(1);
    vi.advanceTimersByTime(SELF_CLOSE_FALLBACK_MS);
    expect(closed).toEqual([]);

    store.set(
      1,
      store.get(1) ??
        createAgentState({
          id: 1,
          sessionId: 's',
          projectDir: '/p',
          jsonlFile: '/p/s.jsonl',
          isExternal: false,
        }),
    );
    const cancel = closeAfterTurn(store, 1, close);
    cancel();
    store.setAgentStatus(1, { active: false, awaitingInput: false });
    vi.advanceTimersByTime(SELF_CLOSE_FALLBACK_MS);
    expect(closed).toEqual([]);
  });
});
