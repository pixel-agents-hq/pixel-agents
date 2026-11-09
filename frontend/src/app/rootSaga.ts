import { all, fork } from 'redux-saga/effects'

import { serverSaga } from '../features/server/serverSaga'

export function* rootSaga() {
  yield all([fork(serverSaga)])
}
