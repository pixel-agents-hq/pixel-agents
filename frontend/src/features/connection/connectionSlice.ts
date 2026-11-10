import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

import { serverMessageReceived } from './actions';

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

interface ConnectionState {
  status: ConnectionStatus;
  /** 預設唯讀，直到伺服器以 officeAccess 明確告知可寫入。 */
  readOnly: boolean;
  terminalAvailable: boolean;
  terminalUnavailableReason: string | null;
  readingTools: string[];
  rejection: string | null;
}

const initialState: ConnectionState = {
  status: 'connecting',
  readOnly: true,
  terminalAvailable: false,
  terminalUnavailableReason: null,
  readingTools: [],
  rejection: null,
};

const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    statusChanged(state, action: PayloadAction<ConnectionStatus>) {
      state.status = action.payload;
    },
    rejectionDismissed(state) {
      state.rejection = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(serverMessageReceived, (state, { payload: message }) => {
      switch (message.type) {
        case 'officeAccess':
          state.readOnly = message.readOnly;
          break;
        case 'terminalAvailability':
          state.terminalAvailable = message.available;
          state.terminalUnavailableReason = message.reason ?? null;
          break;
        case 'providerCapabilities':
          state.readingTools = message.readingTools;
          break;
        case 'workspaceRejected':
        case 'curatorRejected':
        case 'roleRejected':
        case 'directoryRejected':
          state.rejection = message.reason;
          break;
      }
    });
  },
});

export const { statusChanged, rejectionDismissed } = connectionSlice.actions;
export const connectionReducer = connectionSlice.reducer;
