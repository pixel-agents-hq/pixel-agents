import { runSaga, stdChannel } from 'redux-saga';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Agent } from '../agents/agentsSlice';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { canBeCurator, curatorActionFor, curatorChangeRequested, curatorSaga } from './curatorSaga';
import { curatorChangeSettled } from './workspacesSlice';

function start(curators: Record<string, number>) {
  const dispatched: { type: string; payload?: { type?: string } }[] = [];
  const channel = stdChannel();
  const task = runSaga(
    {
      channel,
      dispatch: (action: { type: string }) => {
        dispatched.push(action);
        channel.put(action);
      },
      getState: () => ({ workspaces: { curators } }),
    },
    curatorSaga,
  );
  return { channel, dispatched, task };
}

const sent = (dispatched: { type: string; payload?: { type?: string } }[]) =>
  dispatched.filter((a) => a.type === clientMessageRequested.type).map((a) => a.payload?.type);
const changed = (agentId: number | null, workspaceId = 'ws-1') =>
  serverMessageReceived({ type: 'workspaceCuratorChanged', workspaceId, agentId });
const rejected = (code: 'exists' | 'invalid' | 'not_eligible' | 'unavailable') =>
  serverMessageReceived({ type: 'curatorRejected', code, reason: 'no' });
const req = (workspaceId: string | undefined) =>
  curatorChangeRequested({ workspaceId, agentId: 2 });

describe('curatorSaga', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('沒有 curator 時直接 set', () => {
    const { channel, dispatched, task } = start({});
    channel.put(req('ws-1'));
    expect(sent(dispatched)).toEqual(['setWorkspaceCurator']);
    task.cancel();
  });

  it('自己是 curator 時只送 unset', () => {
    const { channel, dispatched, task } = start({ 'ws-1': 2 });
    channel.put(req('ws-1'));
    channel.put(changed(null));
    expect(sent(dispatched)).toEqual(['unsetWorkspaceCurator']);
    task.cancel();
  });

  it('swap：先送 unset，等 agentId:null 廣播後才送 set', () => {
    const { channel, dispatched, task } = start({ 'ws-1': 1 });
    channel.put(req('ws-1'));
    expect(sent(dispatched)).toEqual(['unsetWorkspaceCurator']);
    channel.put(changed(null));
    expect(sent(dispatched)).toEqual(['unsetWorkspaceCurator', 'setWorkspaceCurator']);
    task.cancel();
  });

  it('swap：unset 被拒絕就停止，不送 set', async () => {
    const { channel, dispatched, task } = start({ 'ws-1': 1 });
    channel.put(req('ws-1'));
    channel.put(rejected('exists'));
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(sent(dispatched)).toEqual(['unsetWorkspaceCurator']);
    expect(dispatched).toContainEqual(curatorChangeSettled('ws-1'));
    task.cancel();
  });

  it('swap：逾時就停止，不送 set，並釋放 pending', async () => {
    const { channel, dispatched, task } = start({ 'ws-1': 1 });
    channel.put(req('ws-1'));
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(sent(dispatched)).toEqual(['unsetWorkspaceCurator']);
    expect(dispatched).toContainEqual(curatorChangeSettled('ws-1'));
    task.cancel();
  });

  it('沒有歸屬的 agent 以 Default 送出', () => {
    const { channel, dispatched, task } = start({});
    channel.put(req(undefined));
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'setWorkspaceCurator',
        workspaceId: DEFAULT_WORKSPACE_ID,
        agentId: 2,
      }),
    );
    task.cancel();
  });
});

describe('curator 判斷', () => {
  it('依目前 curator 決定動作', () => {
    expect(curatorActionFor(undefined, 2)).toBe('set');
    expect(curatorActionFor(2, 2)).toBe('unset');
    expect(curatorActionFor(1, 2)).toBe('swap');
  });

  it('已停止、外部、非本機啟動的 Agent 不符資格', () => {
    const base = { stopped: false, isExternal: false, guard: null } as Agent;
    expect(canBeCurator(base)).toBe(true);
    expect(canBeCurator({ ...base, stopped: true })).toBe(false);
    expect(canBeCurator({ ...base, isExternal: true })).toBe(false);
    expect(
      canBeCurator({
        ...base,
        guard: { active: false, reasons: ['not_standalone_agent'], permissionRoles: null },
      }),
    ).toBe(false);
  });
});
