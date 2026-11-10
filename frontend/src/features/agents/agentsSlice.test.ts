import { describe, expect, it } from 'vitest';

import { serverMessageReceived } from '../connection/actions';
import { agentsReducer } from './agentsSlice';
import { deriveRunState } from './agentSelectors';

const empty = { byId: {}, order: [] };

describe('agentsReducer', () => {
  it('existingAgents 建立 Agent 並套用工作空間與目錄名稱', () => {
    const state = agentsReducer(
      empty,
      serverMessageReceived({
        type: 'existingAgents',
        agents: [1],
        agentMeta: {},
        directoryNames: { '1': 'backend' },
        externalAgents: { '1': false },
        workspaceIds: { '1': 'weiyun' },
      }),
    );
    expect(state.order).toEqual([1]);
    expect(state.byId[1]).toMatchObject({ directoryName: 'backend', workspaceId: 'weiyun' });
  });

  it('工具開始與完成會記錄在 Agent 的工具清單', () => {
    let state = agentsReducer(empty, serverMessageReceived({ type: 'agentCreated', id: 1 }));
    state = agentsReducer(
      state,
      serverMessageReceived({
        type: 'agentToolStart',
        id: 1,
        toolId: 't1',
        status: 'Reading a.ts',
        toolName: 'Read',
      }),
    );
    expect(state.byId[1].tools[0]).toMatchObject({ toolId: 't1', done: false });
    state = agentsReducer(
      state,
      serverMessageReceived({ type: 'agentToolDone', id: 1, toolId: 't1' }),
    );
    expect(state.byId[1].tools[0].done).toBe(true);
  });

  it('建立時帶名稱並標示為尚未啟用，收到 terminalSessionOpened 後變成已啟用', () => {
    let state = agentsReducer(
      empty,
      serverMessageReceived({ type: 'agentCreated', id: 1, name: 'backend', stopped: true }),
    );
    expect(state.byId[1]).toMatchObject({ name: 'backend', stopped: true });
    expect(deriveRunState(state.byId[1])).toBe('stopped');

    state = agentsReducer(
      state,
      serverMessageReceived({ type: 'terminalSessionOpened', agentId: 1 }),
    );
    expect(state.byId[1].stopped).toBe(false);
  });

  it('existingAgents 帶出名稱與尚未啟用的 Agent', () => {
    const state = agentsReducer(
      empty,
      serverMessageReceived({
        type: 'existingAgents',
        agents: [1, 2],
        agentMeta: {},
        directoryNames: { '1': 'a', '2': 'b' },
        externalAgents: {},
        names: { '1': 'backend' },
        stoppedAgents: { '2': true },
      }),
    );
    expect(state.byId[1]).toMatchObject({ name: 'backend', stopped: false });
    expect(state.byId[2]).toMatchObject({ name: null, stopped: true });
  });

  it('agentClosed 移除 Agent', () => {
    let state = agentsReducer(empty, serverMessageReceived({ type: 'agentCreated', id: 1 }));
    state = agentsReducer(state, serverMessageReceived({ type: 'agentClosed', id: 1 }));
    expect(state.order).toEqual([]);
    expect(state.byId[1]).toBeUndefined();
  });
});

describe('deriveRunState', () => {
  const base = agentsReducer(empty, serverMessageReceived({ type: 'agentCreated', id: 1 })).byId[1];

  it('active 為 running', () => {
    expect(deriveRunState({ ...base, status: 'active' })).toBe('running');
  });

  it('waiting 且 awaitingInput 為 waiting', () => {
    expect(deriveRunState({ ...base, status: 'waiting', awaitingInput: true })).toBe('waiting');
  });

  it('waiting 但回合已完成為 idle', () => {
    expect(deriveRunState({ ...base, status: 'waiting', awaitingInput: false })).toBe('idle');
  });
});
