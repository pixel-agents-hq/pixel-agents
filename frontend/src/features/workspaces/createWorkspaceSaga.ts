import { createAction } from '@reduxjs/toolkit';
import { call, delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { isServerMessageOfType } from '../connection/serverMessagePredicates';

interface CreateWorkspaceRequest {
  name: string;
  /** 工作空間根目錄（知識庫 .note/ 所在資料夾），不是 Agent 的 Directory */
  path: string;
}

export const workspaceCreationRequested = createAction<CreateWorkspaceRequest>(
  'workspaces/creationRequested',
);

/** 等到某次 workspacesLoaded 帶有原本沒有的工作空間，回傳它的 id（其他無關的廣播略過）。 */
function* waitForNewWorkspaceId(knownIds: string[]) {
  while (true) {
    const action: ReturnType<typeof serverMessageReceived> = yield take(
      isServerMessageOfType('workspacesLoaded'),
    );
    const message = action.payload;
    if (message.type !== 'workspacesLoaded') continue;
    const created = message.workspaces.find((workspace) => !knownIds.includes(workspace.id));
    if (created !== undefined) return created.id;
  }
}

/**
 * 先建立不含目錄的工作空間，等廣播出現新的工作空間 id 後再為它設定根目錄。
 * 被拒絕或逾時就停止：工作空間會存在但沒有根目錄，可在工作空間頁補設。
 */
function* handleCreation(action: ReturnType<typeof workspaceCreationRequested>) {
  const { name, path } = action.payload;
  const knownIds: string[] = yield select((state: RootState) =>
    state.workspaces.workspaces.map((workspace) => workspace.id),
  );

  yield put(clientMessageRequested({ type: 'saveWorkspace', name, directoryPaths: [] }));
  const { createdId }: { createdId?: string } = yield race({
    createdId: call(waitForNewWorkspaceId, knownIds),
    rejected: take(isServerMessageOfType('workspaceRejected')),
    timeout: delay(LAUNCH_TIMEOUT_MS),
  });
  if (createdId === undefined) return;

  yield put(
    clientMessageRequested({ type: 'setWorkspaceRoot', workspaceId: createdId, rootPath: path }),
  );
}

export function* createWorkspaceSaga() {
  yield takeEvery(workspaceCreationRequested.type, handleCreation);
}
