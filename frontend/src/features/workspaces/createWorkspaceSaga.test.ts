import { runSaga, stdChannel } from 'redux-saga';
import { describe, expect, it } from 'vitest';

import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { createWorkspaceSaga, workspaceCreationRequested } from './createWorkspaceSaga';

function start(registeredPaths: string[]) {
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
        workspaces: {
          directories: registeredPaths.map((path) => ({ name: 'd', path, source: 'user' })),
        },
      }),
    },
    createWorkspaceSaga,
  );
  return { channel, dispatched, task };
}

describe('createWorkspaceSaga', () => {
  it('路徑已登記時直接建立工作空間，不再登記目錄', () => {
    const { channel, dispatched, task } = start(['/p/a']);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '/p/a' }));
    expect(dispatched).toContainEqual(
      clientMessageRequested({ type: 'saveWorkspace', name: 'ws', directoryPaths: ['/p/a'] }),
    );
    expect(dispatched).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'saveDirectory' }) }),
    );
    task.cancel();
  });

  it('先登記目錄，收到 directorySaved 後用伺服器存下的路徑建立工作空間', () => {
    const { channel, dispatched, task } = start([]);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '~/a' }));
    expect(dispatched).toContainEqual(
      clientMessageRequested({ type: 'saveDirectory', name: 'ws', path: '~/a' }),
    );
    channel.put(
      serverMessageReceived({
        type: 'directorySaved',
        directory: { name: 'ws', path: '/home/u/a', source: 'user' },
      }),
    );
    expect(dispatched).toContainEqual(
      clientMessageRequested({ type: 'saveWorkspace', name: 'ws', directoryPaths: ['/home/u/a'] }),
    );
    task.cancel();
  });

  it('目錄被拒絕時不建立工作空間', () => {
    const { channel, dispatched, task } = start([]);
    channel.put(workspaceCreationRequested({ name: 'ws', path: '/nope' }));
    channel.put(
      serverMessageReceived({
        type: 'directoryRejected',
        path: '/nope',
        reason: 'not a directory',
      }),
    );
    expect(dispatched).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'saveWorkspace' }) }),
    );
    task.cancel();
  });
});
