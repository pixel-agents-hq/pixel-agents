import { runSaga, stdChannel } from 'redux-saga';
import { describe, expect, it } from 'vitest';

import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { directoryEditRequested, editDirectorySaga } from './editDirectorySaga';

const WORKSPACE = { id: 'ws-1', name: 'passontw', directoryPaths: ['/p/a', '/p/b'] };

function start() {
  const dispatched: unknown[] = [];
  const channel = stdChannel();
  const task = runSaga(
    {
      channel,
      dispatch: (action: unknown) => {
        dispatched.push(action);
        channel.put(action as { type: string });
      },
      getState: () => ({ workspaces: { workspaces: [WORKSPACE] } }),
    },
    editDirectorySaga,
  );
  return { channel, dispatched, task };
}

const edit = (path: string) =>
  directoryEditRequested({ workspaceId: 'ws-1', previousPath: '/p/a', name: 'A', path });

const saved = (path: string) =>
  serverMessageReceived({
    type: 'directorySaved',
    directory: { name: 'A', path, source: 'user' },
  });

describe('editDirectorySaga', () => {
  it('以 previousPath 送出 saveDirectory', () => {
    const { channel, dispatched, task } = start();
    channel.put(edit('/p/a'));
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'saveDirectory',
        name: 'A',
        path: '/p/a',
        previousPath: '/p/a',
      }),
    );
    task.cancel();
  });

  it('路徑改變後，把工作空間裡的舊路徑換成伺服器回報的路徑', () => {
    const { channel, dispatched, task } = start();
    channel.put(edit('/p/new'));
    channel.put(saved('/p/new'));
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'saveWorkspace',
        id: 'ws-1',
        name: 'passontw',
        directoryPaths: ['/p/new', '/p/b'],
      }),
    );
    task.cancel();
  });

  it('只改名稱、路徑沒變時不動工作空間', () => {
    const { channel, dispatched, task } = start();
    channel.put(edit('/p/a'));
    channel.put(saved('/p/a'));
    expect(dispatched).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'saveWorkspace' }) }),
    );
    task.cancel();
  });

  it('伺服器拒絕時不動工作空間', () => {
    const { channel, dispatched, task } = start();
    channel.put(edit('/p/new'));
    channel.put(
      serverMessageReceived({
        type: 'directoryRejected',
        path: '/p/new',
        reason: 'not a directory',
      }),
    );
    expect(dispatched).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ type: 'saveWorkspace' }) }),
    );
    task.cancel();
  });
});
