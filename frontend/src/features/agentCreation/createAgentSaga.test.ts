import { runSaga, stdChannel } from 'redux-saga';
import { describe, expect, it } from 'vitest';

import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { agentCreationRequested, createAgentSaga } from './createAgentSaga';

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
      getState: () => ({}),
    },
    createAgentSaga,
  );
  return { channel, dispatched, task };
}

const base = {
  workspaceId: 'w1',
  name: '',
  directoryPath: '/p/a',
  permissionRoles: null,
  start: false,
  becomeCurator: false,
};

describe('createAgentSaga', () => {
  it('送出 createAgent；沒有名稱就不帶 name', () => {
    const { channel, dispatched, task } = start();
    channel.put(agentCreationRequested(base));
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'createAgent',
        workspaceId: 'w1',
        directoryPath: '/p/a',
        permissionRoles: null,
        start: false,
      }),
    );
    task.cancel();
  });

  it('帶名稱與立即啟用', () => {
    const { channel, dispatched, task } = start();
    channel.put(agentCreationRequested({ ...base, name: 'backend', start: true }));
    expect(dispatched).toContainEqual(
      clientMessageRequested({
        type: 'createAgent',
        workspaceId: 'w1',
        directoryPath: '/p/a',
        permissionRoles: null,
        start: true,
        name: 'backend',
      }),
    );
    task.cancel();
  });

  it('要指定 KB Writer 時，等該工作空間的 agentCreated 後才送 setWorkspaceCurator', () => {
    const { channel, dispatched, task } = start();
    channel.put(agentCreationRequested({ ...base, start: true, becomeCurator: true }));
    const curatorMessage = clientMessageRequested({
      type: 'setWorkspaceCurator',
      workspaceId: 'w1',
      agentId: 7,
    });
    expect(dispatched).not.toContainEqual(curatorMessage);

    channel.put(serverMessageReceived({ type: 'agentCreated', id: 6, workspaceId: 'other' }));
    expect(dispatched).not.toContainEqual(curatorMessage);

    channel.put(serverMessageReceived({ type: 'agentCreated', id: 7, workspaceId: 'w1' }));
    expect(dispatched).toContainEqual(curatorMessage);
    task.cancel();
  });
});
