import { buffers } from 'redux-saga';
import type { Channel } from 'redux-saga';
import { actionChannel, delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { KB_REQUEST_TIMEOUT_MS } from '../../constants';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { kbFileSelected, kbListRequested, kbTargetKey } from './kbSlice';

type RequestAction = ReturnType<typeof kbFileSelected>;

/** 未連線時請求送不出去；這時不發請求，免得永遠等不到。 */
function* canRequest() {
  const connection: RootState['connection'] = yield select((state: RootState) => state.connection);
  return connection.status === 'connected';
}

function* handleList(action: ReturnType<typeof kbListRequested>) {
  if (!(yield* canRequest())) return;
  yield put(clientMessageRequested({ type: 'listKbFiles', target: action.payload }));
}

function isReplyTo({ target, relPath }: RequestAction['payload']) {
  return (action: { type: string }) => {
    if (!serverMessageReceived.match(action)) return false;
    const message = action.payload;
    return (
      (message.type === 'kbFileRead' || message.type === 'kbRejected') &&
      message.target !== undefined &&
      kbTargetKey(message.target) === kbTargetKey(target) &&
      message.relPath === relPath
    );
  };
}

/**
 * 伺服器每條連線最多同時處理 2 個 KB 請求，所以讀檔一次只送一個，等回覆（或逾時）再送下一個。
 * 等待期間連點只保留最後一次選擇（sliding buffer）。
 */
function* readQueue() {
  const channel: Channel<RequestAction> = yield actionChannel(
    kbFileSelected.type,
    buffers.sliding<RequestAction>(1),
  );
  while (true) {
    const action: RequestAction = yield take(channel);
    if (!(yield* canRequest())) continue;
    const { target, relPath } = action.payload;
    yield put(clientMessageRequested({ type: 'readKbFile', target, relPath }));
    yield race({
      reply: take(isReplyTo(action.payload)),
      timeout: delay(KB_REQUEST_TIMEOUT_MS),
    });
  }
}

export function* kbSaga() {
  yield takeEvery(kbListRequested.type, handleList);
  yield* readQueue();
}
