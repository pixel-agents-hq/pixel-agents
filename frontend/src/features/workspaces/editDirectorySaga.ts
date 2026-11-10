import { createAction } from '@reduxjs/toolkit';
import { delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { isServerMessageOfType } from '../connection/serverMessagePredicates';
import { selectWorkspace } from './workspaceSelectors';

interface EditDirectoryRequest {
  workspaceId: string;
  previousPath: string;
  name: string;
  path: string;
}

export const directoryEditRequested = createAction<EditDirectoryRequest>(
  'workspaces/directoryEditRequested',
);

type ReceivedAction = ReturnType<typeof serverMessageReceived>;

/**
 * 伺服器改 Directory 時不會動工作空間的成員清單，路徑一變，工作空間裡存的還是舊路徑。
 * 所以路徑真的變了，要等伺服器回報實際存下的路徑，再把工作空間裡的舊路徑換掉。
 */
function* handleEdit(action: ReturnType<typeof directoryEditRequested>) {
  const { workspaceId, previousPath, name, path } = action.payload;
  yield put(clientMessageRequested({ type: 'saveDirectory', name, path, previousPath }));

  const { saved }: { saved?: ReceivedAction } = yield race({
    saved: take(isServerMessageOfType('directorySaved')),
    rejected: take(isServerMessageOfType('directoryRejected')),
    timeout: delay(LAUNCH_TIMEOUT_MS),
  });
  const message = saved?.payload;
  if (message?.type !== 'directorySaved' || message.directory.path === previousPath) return;

  const workspace: ReturnType<typeof selectWorkspace> = yield select((state: RootState) =>
    selectWorkspace(state, workspaceId),
  );
  if (!workspace?.directoryPaths.includes(previousPath)) return;
  yield put(
    clientMessageRequested({
      type: 'saveWorkspace',
      id: workspace.id,
      name: workspace.name,
      directoryPaths: workspace.directoryPaths.map((owned) =>
        owned === previousPath ? message.directory.path : owned,
      ),
    }),
  );
}

export function* editDirectorySaga() {
  yield takeEvery(directoryEditRequested.type, handleEdit);
}
