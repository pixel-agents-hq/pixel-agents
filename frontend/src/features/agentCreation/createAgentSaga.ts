import { createAction } from '@reduxjs/toolkit';
import { delay, put, race, take, takeEvery } from 'redux-saga/effects';

import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { PermissionRole } from '../../protocol';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';

interface CreateAgentRequest {
  workspaceId: string;
  /** 空字串表示沒有名稱，以目錄名稱標示 */
  name: string;
  directoryPath: string;
  permissionRoles: PermissionRole[] | null;
  /** 建立後立即啟用；否則只建立紀錄，之後在工作空間裡啟用 */
  start: boolean;
  /** 建立後，把新 agent 指定為該工作空間的 KB Writer（需要已啟用） */
  becomeCurator: boolean;
}

export const agentCreationRequested = createAction<CreateAgentRequest>('agents/creationRequested');

type ReceivedAction = ReturnType<typeof serverMessageReceived>;

function isCreatedIn(workspaceId: string) {
  return (action: { type: string }) =>
    serverMessageReceived.match(action) &&
    action.payload.type === 'agentCreated' &&
    (action.payload.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId;
}

function* handleCreation(action: ReturnType<typeof agentCreationRequested>) {
  const { workspaceId, name, directoryPath, permissionRoles, start, becomeCurator } =
    action.payload;
  yield put(
    clientMessageRequested({
      type: 'createAgent',
      directoryPath,
      permissionRoles,
      start,
      ...(name === '' ? {} : { name }),
    }),
  );
  if (!becomeCurator) return;

  const { created }: { created?: ReceivedAction } = yield race({
    created: take(isCreatedIn(workspaceId)),
    timeout: delay(LAUNCH_TIMEOUT_MS),
  });
  const createdMessage = created?.payload;
  if (createdMessage?.type === 'agentCreated') {
    yield put(
      clientMessageRequested({
        type: 'setWorkspaceCurator',
        workspaceId,
        agentId: createdMessage.id,
      }),
    );
  }
}

export function* createAgentSaga() {
  yield takeEvery(agentCreationRequested.type, handleCreation);
}
