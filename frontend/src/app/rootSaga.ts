import { all, fork } from 'redux-saga/effects';

import { connectionSaga } from '../features/connection/connectionSaga';
import { createAgentSaga } from '../features/agentCreation/createAgentSaga';
import { createWorkspaceSaga } from '../features/workspaces/createWorkspaceSaga';
import { editDirectorySaga } from '../features/workspaces/editDirectorySaga';

export function* rootSaga() {
  yield all([
    fork(connectionSaga),
    fork(createAgentSaga),
    fork(createWorkspaceSaga),
    fork(editDirectorySaga),
  ]);
}
