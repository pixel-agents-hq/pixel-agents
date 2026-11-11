import { createAction } from '@reduxjs/toolkit';
import { call, delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import { clientMessageRequested } from '../connection/actions';
import { rejectionDismissed } from '../connection/connectionSlice';
import { isServerMessageOfType } from '../connection/serverMessagePredicates';
import { selectWorkspace } from './workspaceSelectors';
import { buildSavePayload, metaChanged, reflectsDraft, rootChanged } from './workspaceSettings';
import type { WorkspaceDraft } from './workspaceSettings';
import { saveSettled, saveStarted } from './workspacesSlice';

export const workspaceSaveRequested = createAction<{
  workspaceId: string;
  draft: WorkspaceDraft;
}>('workspaces/saveRequested');

/** 成功 = 之後的 workspacesLoaded 裡，該工作空間的名稱與目錄集合等於送出的草稿。 */
function* waitForSavedWorkspace(workspaceId: string, draft: WorkspaceDraft) {
  while (true) {
    yield take(isServerMessageOfType('workspacesLoaded'));
    const current: ReturnType<typeof selectWorkspace> = yield select((state: RootState) =>
      selectWorkspace(state, workspaceId),
    );
    if (reflectsDraft(current, draft)) return;
  }
}

/** 成功 = 該工作空間廣播出來的 rootPath 與送出前不同（伺服器存的是 realpath，不能拿輸入值比對）。 */
function* waitForRootChange(workspaceId: string, before: string | undefined) {
  while (true) {
    yield take(isServerMessageOfType('workspacesLoaded'));
    const current: string | undefined = yield select(
      (state: RootState) => selectWorkspace(state, workspaceId)?.rootPath,
    );
    if (current !== before) return;
  }
}

function* handleSave({ payload }: ReturnType<typeof workspaceSaveRequested>) {
  const { workspaceId, draft } = payload;
  if (workspaceId === DEFAULT_WORKSPACE_ID) return;
  const before: ReturnType<typeof selectWorkspace> = yield select((state: RootState) =>
    selectWorkspace(state, workspaceId),
  );
  if (!before) return;

  yield put(rejectionDismissed());
  yield put(saveStarted(workspaceId));
  try {
    // 名稱與目錄先存；這一步被退回或逾時就停下，不再送根目錄變更。
    if (metaChanged(before, draft)) {
      yield put(clientMessageRequested(buildSavePayload(workspaceId, draft)));
      const meta: { saved?: unknown } = yield race({
        saved: call(waitForSavedWorkspace, workspaceId, draft),
        rejected: take(isServerMessageOfType('workspaceRejected')),
        timeout: delay(LAUNCH_TIMEOUT_MS),
      });
      if (!('saved' in meta)) return;
    }
    if (rootChanged(before, draft)) {
      const rootPath = draft.rootPath.trim();
      yield put(
        clientMessageRequested({
          type: 'setWorkspaceRoot',
          workspaceId,
          rootPath: rootPath === '' ? null : rootPath,
        }),
      );
      yield race({
        changed: call(waitForRootChange, workspaceId, before.rootPath),
        rejected: take(isServerMessageOfType('workspaceRejected')),
        timeout: delay(LAUNCH_TIMEOUT_MS),
      });
    }
  } finally {
    yield put(saveSettled(workspaceId));
  }
}

export function* workspaceSettingsSaga() {
  yield takeEvery(workspaceSaveRequested.type, handleSave);
}
