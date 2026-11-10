import { all, fork } from 'redux-saga/effects';

import { connectionSaga } from '../features/connection/connectionSaga';
import { launchSaga } from '../features/launch/launchSaga';
import { createWorkspaceSaga } from '../features/workspaces/createWorkspaceSaga';

export function* rootSaga() {
  yield all([fork(connectionSaga), fork(launchSaga), fork(createWorkspaceSaga)]);
}
