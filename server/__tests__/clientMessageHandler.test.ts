import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import type { AgentState } from '../src/types.js';

describe('handleClientMessage: requestActivity', () => {
  it('replies with agentActivityHistory including projectDir and entries', () => {
    const store = new AgentStateStore();
    const entry = { ts: 1, kind: 'tool', label: 'Reading foo.ts', toolName: 'Read' };
    store.set(1, { id: 1, projectDir: '/my/proj', activityLog: [entry] } as unknown as AgentState);

    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'requestActivity', id: 1 }, (m) => sent.push(m), {
      store,
      cache: null,
    });

    expect(sent).toContainEqual({
      type: 'agentActivityHistory',
      id: 1,
      projectDir: '/my/proj',
      entries: [entry],
    });
  });

  it('replies with empty entries for an unknown agent', () => {
    const store = new AgentStateStore();
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'requestActivity', id: 42 }, (m) => sent.push(m), {
      store,
      cache: null,
    });
    expect(sent).toContainEqual({
      type: 'agentActivityHistory',
      id: 42,
      projectDir: undefined,
      entries: [],
    });
  });
});
