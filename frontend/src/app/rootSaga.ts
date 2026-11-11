import { all, fork } from 'redux-saga/effects';

import { connectionSaga } from '../features/connection/connectionSaga';
import { createAgentSaga } from '../features/agentCreation/createAgentSaga';
import { kbSaga } from '../features/kb/kbSaga';
import { createWorkspaceSaga } from '../features/workspaces/createWorkspaceSaga';
import { curatorSaga } from '../features/workspaces/curatorSaga';
import { editDirectorySaga } from '../features/workspaces/editDirectorySaga';
import { workspaceSettingsSaga } from '../features/workspaces/workspaceSettingsSaga';

export function* rootSaga() {
  yield all([
    fork(connectionSaga),
    fork(createAgentSaga),
    fork(createWorkspaceSaga),
    fork(editDirectorySaga),
    fork(kbSaga),
    fork(curatorSaga),
    fork(workspaceSettingsSaga),
  ]);
}
