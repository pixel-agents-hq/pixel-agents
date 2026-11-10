import { createAction } from '@reduxjs/toolkit';
import { delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { isServerMessageOfType } from '../connection/serverMessagePredicates';

interface CreateWorkspaceRequest {
  name: string;
  path: string;
}

export const workspaceCreationRequested = createAction<CreateWorkspaceRequest>(
  'workspaces/creationRequested',
);

type ReceivedAction = ReturnType<typeof serverMessageReceived>;

/**
 * 工作空間包含的是「已登記的目錄」，所以先登記路徑，伺服器回報實際存下的路徑後，
 * 再建立只含這個目錄的工作空間。路徑已經登記過就直接建立。
 */
function* handleCreation(action: ReturnType<typeof workspaceCreationRequested>) {
  const { name, path } = action.payload;
  const registered: string | undefined = yield select(
    (state: RootState) => state.workspaces.directories.find((d) => d.path === path)?.path,
  );

  let directoryPath = registered;
  if (directoryPath === undefined) {
    yield put(clientMessageRequested({ type: 'saveDirectory', name, path }));
    const { saved }: { saved?: ReceivedAction } = yield race({
      saved: take(isServerMessageOfType('directorySaved')),
      rejected: take(isServerMessageOfType('directoryRejected')),
      timeout: delay(LAUNCH_TIMEOUT_MS),
    });
    const message = saved?.payload;
    if (message?.type !== 'directorySaved') return;
    directoryPath = message.directory.path;
  }

  yield put(
    clientMessageRequested({ type: 'saveWorkspace', name, directoryPaths: [directoryPath] }),
  );
}

export function* createWorkspaceSaga() {
  yield takeEvery(workspaceCreationRequested.type, handleCreation);
}
