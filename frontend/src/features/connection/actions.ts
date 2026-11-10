import { createAction } from '@reduxjs/toolkit';

import type { ClientMessage, ServerMessage } from '../../protocol';

export const serverMessageReceived = createAction(
  'connection/serverMessageReceived',
  (message: ServerMessage) => ({ payload: message, meta: { receivedAt: Date.now() } }),
);

export const clientMessageRequested = createAction<ClientMessage>(
  'connection/clientMessageRequested',
);
