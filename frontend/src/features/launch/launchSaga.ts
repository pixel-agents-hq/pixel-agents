import { createAction } from '@reduxjs/toolkit';
import { delay, put, race, take, takeEvery } from 'redux-saga/effects';

import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { PermissionRole } from '../../protocol';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';

interface LaunchRequest {
  workspaceId: string;
  directoryPath: string;
  permissionRoles: PermissionRole[] | null;
  /** 啟動成功後，把新 agent 指定為該工作空間的 KB Writer */
  becomeCurator: boolean;
}

export const launchRequested = createAction<LaunchRequest>('launch/requested');

type ReceivedAction = ReturnType<typeof serverMessageReceived>;

function isCreatedIn(workspaceId: string) {
  return (action: { type: string }) =>
    serverMessageReceived.match(action) &&
    action.payload.type === 'agentCreated' &&
    (action.payload.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId;
}

function* handleLaunch(action: ReturnType<typeof launchRequested>) {
  const { workspaceId, directoryPath, permissionRoles, becomeCurator } = action.payload;
  yield put(clientMessageRequested({ type: 'launchAgent', directoryPath, permissionRoles }));
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

export function* launchSaga() {
  yield takeEvery(launchRequested.type, handleLaunch);
}
