import { runSaga, stdChannel } from 'redux-saga';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { workspaceSaveRequested, workspaceSettingsSaga } from './workspaceSettingsSaga';
import { saveSettled, saveStarted } from './workspacesSlice';

function start(readOnly = false) {
  const dispatched: unknown[] = [];
  const state = {
    connection: { readOnly },
    workspaces: {
      workspaces: [{ id: 'ws-1', name: 'old', directoryPaths: ['/a'], rootPath: '/root' }],
    },
  };
  const channel = stdChannel();
  const task = runSaga(
    {
      channel,
      dispatch: (action: unknown) => {
        dispatched.push(action);
        channel.put(action as { type: string });
      },
      getState: () => state,
    },
    workspaceSettingsSaga,
  );
  return { channel, dispatched, task, state };
}

const draft = { name: ' new ', directoryPaths: ['/a', '/b'], rootPath: '/root' };
const request = (workspaceId = 'ws-1') => workspaceSaveRequested({ workspaceId, draft });
const loaded = () => serverMessageReceived({ type: 'workspacesLoaded', workspaces: [] });
const sentMessages = (dispatched: unknown[]) =>
  dispatched.filter((x) => (x as { type: string }).type === clientMessageRequested.type);

describe('workspaceSettingsSaga', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('只在收到儲存請求時送出 saveWorkspace，且不帶 rootPath 與權限角色', () => {
    const { channel, dispatched, task } = start();
    expect(sentMessages(dispatched)).toHaveLength(0);
    channel.put(request());
    expect(dispatched).toContainEqual(saveStarted('ws-1'));
    expect(sentMessages(dispatched)).toEqual([
      clientMessageRequested({
        type: 'saveWorkspace',
        id: 'ws-1',
        name: 'new',
        directoryPaths: ['/a', '/b'],
      }),
    ]);
    task.cancel();
  });

  it('廣播反映草稿才釋放 pending', () => {
    const { channel, dispatched, task, state } = start();
    channel.put(request());
    channel.put(loaded());
    expect(dispatched).not.toContainEqual(saveSettled('ws-1'));
    Object.assign(state.workspaces.workspaces[0], { name: 'new', directoryPaths: ['/b', '/a'] });
    channel.put(loaded());
    expect(dispatched).toContainEqual(saveSettled('ws-1'));
    task.cancel();
  });

  it('根目錄有改就在名稱與目錄存好之後再送 setWorkspaceRoot，清空送 null', () => {
    const { channel, dispatched, task, state } = start();
    channel.put(
      workspaceSaveRequested({
        workspaceId: 'ws-1',
        draft: { ...draft, rootPath: '  /next ' },
      }),
    );
    expect(sentMessages(dispatched)).toHaveLength(1);
    Object.assign(state.workspaces.workspaces[0], { name: 'new', directoryPaths: ['/b', '/a'] });
    channel.put(loaded());
    expect(sentMessages(dispatched)[1]).toEqual(
      clientMessageRequested({ type: 'setWorkspaceRoot', workspaceId: 'ws-1', rootPath: '/next' }),
    );
    Object.assign(state.workspaces.workspaces[0], { rootPath: '/next' });
    channel.put(loaded());
    expect(dispatched).toContainEqual(saveSettled('ws-1'));
    task.cancel();

    const cleared = start();
    cleared.channel.put(
      workspaceSaveRequested({
        workspaceId: 'ws-1',
        draft: { name: 'old', directoryPaths: ['/a'], rootPath: '' },
      }),
    );
    expect(sentMessages(cleared.dispatched)).toEqual([
      clientMessageRequested({ type: 'setWorkspaceRoot', workspaceId: 'ws-1', rootPath: null }),
    ]);
    cleared.task.cancel();
  });

  it('只改根目錄時不送 saveWorkspace', () => {
    const { channel, dispatched, task } = start();
    channel.put(
      workspaceSaveRequested({
        workspaceId: 'ws-1',
        draft: { name: 'old', directoryPaths: ['/a'], rootPath: '/other' },
      }),
    );
    expect(
      sentMessages(dispatched).map((m) => (m as { payload: { type: string } }).payload.type),
    ).toEqual(['setWorkspaceRoot']);
    task.cancel();
  });

  it('名稱與目錄被退回時不再送根目錄變更', () => {
    const { channel, dispatched, task } = start();
    channel.put(request());
    channel.put(serverMessageReceived({ type: 'workspaceRejected', reason: 'bad' }));
    expect(sentMessages(dispatched)).toHaveLength(1);
    expect(dispatched).toContainEqual(saveSettled('ws-1'));
    task.cancel();
  });

  it('workspaceRejected 釋放 pending', () => {
    const { channel, dispatched, task } = start();
    channel.put(request());
    channel.put(serverMessageReceived({ type: 'workspaceRejected', reason: 'bad' }));
    expect(dispatched).toContainEqual(saveSettled('ws-1'));
    task.cancel();
  });

  it('逾時釋放 pending', async () => {
    const { channel, dispatched, task } = start();
    channel.put(request());
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS);
    expect(dispatched).toContainEqual(saveSettled('ws-1'));
    task.cancel();
  });

  it('唯讀與 Default 不送出任何訊息', () => {
    const a = start(true);
    a.channel.put(request());
    expect(sentMessages(a.dispatched)).toHaveLength(0);
    a.task.cancel();
    const b = start();
    b.channel.put(request('default'));
    expect(sentMessages(b.dispatched)).toHaveLength(0);
    b.task.cancel();
  });
});
