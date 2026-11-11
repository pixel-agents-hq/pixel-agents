import { eventChannel } from 'redux-saga';
import type { EventChannel } from 'redux-saga';
import { call, delay, put, take, takeEvery } from 'redux-saga/effects';

import { WS_RECONNECT_DELAYS_MS } from '../../constants';
import type { ClientMessage, ServerMessage } from '../../protocol';
import { clientMessageRequested, serverMessageReceived } from './actions';
import { statusChanged } from './connectionSlice';

type SocketEvent =
  { kind: 'open' } | { kind: 'message'; message: ServerMessage } | { kind: 'close' };

let activeSocket: WebSocket | null = null;

export function buildSocketUrl(location: Pick<Location, 'protocol' | 'host'>) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

export function reconnectDelayMs(attempt: number) {
  return WS_RECONNECT_DELAYS_MS[Math.min(attempt, WS_RECONNECT_DELAYS_MS.length - 1)];
}

function createSocketChannel(socket: WebSocket): EventChannel<SocketEvent> {
  return eventChannel<SocketEvent>((emit) => {
    socket.onopen = () => emit({ kind: 'open' });
    socket.onmessage = (event) => {
      try {
        emit({ kind: 'message', message: JSON.parse(String(event.data)) as ServerMessage });
      } catch {
        // 格式不符的訊息直接丟棄，與舊前端一致
      }
    };
    socket.onclose = () => {
      emit({ kind: 'close' });
    };
    return () => {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    };
  });
}

function sendClientMessage(message: ClientMessage) {
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(message));
  }
}

function* forwardClientMessage(action: ReturnType<typeof clientMessageRequested>) {
  yield call(sendClientMessage, action.payload);
}

function* runConnection(attempt: number) {
  yield put(statusChanged(attempt === 0 ? 'connecting' : 'reconnecting'));
  const socket = new WebSocket(buildSocketUrl(window.location));
  activeSocket = socket;
  const channel: EventChannel<SocketEvent> = yield call(createSocketChannel, socket);
  let opened = false;
  try {
    while (true) {
      const event: SocketEvent = yield take(channel);
      if (event.kind === 'open') {
        opened = true;
        yield put(statusChanged('connected'));
        yield put(clientMessageRequested({ type: 'webviewReady' }));
      } else if (event.kind === 'message') {
        yield put(serverMessageReceived(event.message));
      } else {
        break;
      }
    }
  } finally {
    channel.close();
    activeSocket = null;
  }
  return opened;
}

export function* connectionSaga() {
  yield takeEvery(clientMessageRequested.type, forwardClientMessage);
  let attempt = 0;
  while (true) {
    const opened: boolean = yield call(runConnection, attempt);
    attempt = opened ? 0 : attempt + 1;
    yield put(statusChanged('reconnecting'));
    yield delay(reconnectDelayMs(attempt));
  }
}
