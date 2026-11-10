import { createSlice } from '@reduxjs/toolkit';

import { serverMessageReceived } from '../connection/actions';
import type { Directory, Workspace } from '../../protocol';

interface WorkspacesState {
  loaded: boolean;
  workspaces: Workspace[];
  directories: Directory[];
  curatorsAvailable: boolean;
  /** workspaceId -> 擔任 KB Writer 的 agentId */
  curators: Record<string, number>;
}

const initialState: WorkspacesState = {
  loaded: false,
  workspaces: [],
  directories: [],
  curatorsAvailable: false,
  curators: {},
};

const workspacesSlice = createSlice({
  name: 'workspaces',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(serverMessageReceived, (state, { payload: message }) => {
      switch (message.type) {
        case 'workspacesLoaded':
          state.workspaces = message.workspaces;
          state.loaded = true;
          break;
        case 'directoriesLoaded':
          state.directories = message.directories;
          break;
        case 'curatorsLoaded':
          state.curatorsAvailable = message.available;
          state.curators = Object.fromEntries(
            message.curators.map((entry) => [entry.workspaceId, entry.agentId]),
          );
          break;
        case 'workspaceCuratorChanged':
          if (message.agentId === null) {
            delete state.curators[message.workspaceId];
          } else {
            state.curators[message.workspaceId] = message.agentId;
          }
          break;
      }
    });
  },
});

export const workspacesReducer = workspacesSlice.reducer;
