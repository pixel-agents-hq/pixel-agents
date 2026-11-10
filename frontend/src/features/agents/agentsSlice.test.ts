import { describe, expect, it } from 'vitest';

import { serverMessageReceived } from '../connection/actions';
import { agentsReducer } from './agentsSlice';
import { backgroundTools, deriveRunState, foregroundTools } from './agentSelectors';

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

  describe('子代理與背景工具', () => {
    const created = () =>
      agentsReducer(empty, serverMessageReceived({ type: 'agentCreated', id: 1 }));
    const subTool = (toolId: string, status = 'Reading b.ts') =>
      serverMessageReceived({
        type: 'subagentToolStart',
        id: 1,
        parentToolId: 'task1',
        toolId,
        status,
      });

    it('背景執行的工具會帶 runInBackground', () => {
      const state = agentsReducer(
        created(),
        serverMessageReceived({
          type: 'agentToolStart',
          id: 1,
          toolId: 'b1',
          status: 'Running dev server',
          toolName: 'Bash',
          runInBackground: true,
        }),
      );
      expect(state.byId[1].tools[0]).toMatchObject({ toolId: 'b1', runInBackground: true });
    });

    it('子代理的工具活動依 parentToolId 歸在同一個子代理下', () => {
      let state = agentsReducer(created(), subTool('s1'));
      state = agentsReducer(state, subTool('s2', 'Editing c.ts'));
      expect(state.byId[1].subagents).toHaveLength(1);
      expect(state.byId[1].subagents[0].tools.map((t) => t.toolId)).toEqual(['s1', 's2']);
    });

    it('子代理只保留最近的工具活動', () => {
      let state = created();
      for (let i = 0; i < 15; i++) state = agentsReducer(state, subTool(`s${i}`));
      const tools = state.byId[1].subagents[0].tools;
      expect(tools).toHaveLength(10);
      expect(tools[0].toolId).toBe('s5');
    });

    it('subagentToolDone 標記完成，subagentClear 移除該子代理', () => {
      let state = agentsReducer(created(), subTool('s1'));
      state = agentsReducer(
        state,
        serverMessageReceived({
          type: 'subagentToolDone',
          id: 1,
          parentToolId: 'task1',
          toolId: 's1',
        }),
      );
      expect(state.byId[1].subagents[0].tools[0].done).toBe(true);
      state = agentsReducer(
        state,
        serverMessageReceived({ type: 'subagentClear', id: 1, parentToolId: 'task1' }),
      );
      expect(state.byId[1].subagents).toEqual([]);
    });

    it('子代理的權限提示會標記，工具完成後解除', () => {
      let state = agentsReducer(created(), subTool('s1'));
      state = agentsReducer(
        state,
        serverMessageReceived({ type: 'subagentToolPermission', id: 1, parentToolId: 'task1' }),
      );
      expect(state.byId[1].subagents[0].permissionPending).toBe(true);
      state = agentsReducer(
        state,
        serverMessageReceived({
          type: 'subagentToolDone',
          id: 1,
          parentToolId: 'task1',
          toolId: 's1',
        }),
      );
      expect(state.byId[1].subagents[0].permissionPending).toBe(false);
    });

    it('agentToolsClear（回合結束）清掉所有子代理', () => {
      let state = agentsReducer(created(), subTool('s1'));
      state = agentsReducer(state, serverMessageReceived({ type: 'agentToolsClear', id: 1 }));
      expect(state.byId[1].subagents).toEqual([]);
    });

    it('主程序工具清單不重複列出子代理與背景工具', () => {
      let state = created();
      const start = (toolId: string, extra: object = {}) =>
        serverMessageReceived({
          type: 'agentToolStart',
          id: 1,
          toolId,
          status: toolId,
          ...extra,
        });
      state = agentsReducer(state, start('read1', { toolName: 'Read' }));
      state = agentsReducer(state, start('task1', { toolName: 'Task' }));
      state = agentsReducer(state, start('bg1', { toolName: 'Bash', runInBackground: true }));
      state = agentsReducer(state, subTool('s1'));
      const agent = state.byId[1];
      expect(foregroundTools(agent).map((t) => t.toolId)).toEqual(['read1']);
      expect(backgroundTools(agent).map((t) => t.toolId)).toEqual(['bg1']);
    });
  });
});
