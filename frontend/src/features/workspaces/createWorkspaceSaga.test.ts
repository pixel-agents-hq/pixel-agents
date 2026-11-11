import { runSaga, stdChannel } from 'redux-saga';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LAUNCH_TIMEOUT_MS } from '../../constants';

import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { createWorkspaceSaga, workspaceCreationRequested } from './createWorkspaceSaga';

function start(existingIds: string[]) {
  const dispatched: unknown[] = [];
  const channel = stdChannel();
  const task = runSaga(
    {
      channel,
      dispatch: (action: unknown) => {
        dispatched.push(action);
        channel.put(action as { type: string });
      },
      getState: () => ({
        workspaces: { workspaces: existingIds.map((id) => ({ id, name: id, directoryPaths: [] })) },
      }),
    },
    createWorkspaceSaga,
  );
  return { channel, dispatched, task };
}

const workspace = (id: string) => ({ id, name: id, directoryPaths: [] });
const messageTypes = (dispatched: unknown[]) =>
  dispatched.map((action) => (action as { payload?: { type?: string } }).payload?.type);

describe('createWorkspaceSaga', () => {
  afterEach(() => vi.useRealTimers());

  it('先送出不含目錄的 saveWorkspace，收到新工作空間的廣播後才設定根目錄，且不登記目錄', () => {
    const { channel, dispatched, task } = start(['default']);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '/p/root' }));
    expect(dispatched).toContainEqual(
      clientMessageRequested({ type: 'saveWorkspace', name: 'ws', directoryPaths: [] }),
    );
    expect(messageTypes(dispatched)).not.toContain('setWorkspaceRoot');

    channel.put(
      serverMessageReceived({ type: 'workspacesLoaded', workspaces: [workspace('default')] }),
    );
    expect(messageTypes(dispatched)).not.toContain('setWorkspaceRoot');

    channel.put(
      serverMessageReceived({
        type: 'workspacesLoaded',
        workspaces: [workspace('default'), workspace('new-id')],
      }),
    );
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'setWorkspaceRoot',
        workspaceId: 'new-id',
        rootPath: '/p/root',
      }),
    );
    expect(messageTypes(dispatched)).not.toContain('saveDirectory');
    task.cancel();
  });

  it('被拒絕時不設定根目錄', () => {
    const { channel, dispatched, task } = start(['default']);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '/p/root' }));
    channel.put(serverMessageReceived({ type: 'workspaceRejected', reason: 'nope' }));
    channel.put(
      serverMessageReceived({
        type: 'workspacesLoaded',
        workspaces: [workspace('default'), workspace('late')],
      }),
    );
    expect(messageTypes(dispatched)).not.toContain('setWorkspaceRoot');
    task.cancel();
  });

  it('逾時時不設定根目錄', async () => {
    vi.useFakeTimers();
    const { channel, dispatched, task } = start(['default']);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '/p/root' }));
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS + 1);
    channel.put(
      serverMessageReceived({
        type: 'workspacesLoaded',
        workspaces: [workspace('default'), workspace('late')],
      }),
    );
    expect(messageTypes(dispatched)).not.toContain('setWorkspaceRoot');
    task.cancel();
  });
});
