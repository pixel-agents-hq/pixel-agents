import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

import { serverMessageReceived } from '../connection/actions';
import type { Directory, Workspace } from '../../protocol';

interface WorkspacesState {
  loaded: boolean;
  workspaces: Workspace[];
  directories: Directory[];
  curatorsAvailable: boolean;
  /** workspaceId -> 擔任 KB Writer 的 agentId */
  curators: Record<string, number>;
  /** workspaceId -> 綁定的目錄 realpath（KB Writer 職缺時用來顯示會由哪個目錄的 Agent 自動恢復） */
  bindings: Record<string, string>;
  /** 已送出、還在等伺服器回覆的名稱、目錄與根目錄變更（workspaceId） */
  pendingSaves: string[];
  /** 已送出、還在等伺服器回覆的 KB Writer 變更（workspaceId） */
  pendingCurators: string[];
}

const initialState: WorkspacesState = {
  loaded: false,
  workspaces: [],
  directories: [],
  curatorsAvailable: false,
  curators: {},
  bindings: {},
  pendingSaves: [],
  pendingCurators: [],
};

const workspacesSlice = createSlice({
  name: 'workspaces',
  initialState,
  reducers: {
    saveStarted(state, action: PayloadAction<string>) {
      if (!state.pendingSaves.includes(action.payload)) state.pendingSaves.push(action.payload);
    },
    saveSettled(state, action: PayloadAction<string>) {
      state.pendingSaves = state.pendingSaves.filter((id) => id !== action.payload);
    },
    curatorChangeStarted(state, action: PayloadAction<string>) {
      if (!state.pendingCurators.includes(action.payload)) {
        state.pendingCurators.push(action.payload);
      }
    },
    curatorChangeSettled(state, action: PayloadAction<string>) {
      state.pendingCurators = state.pendingCurators.filter((id) => id !== action.payload);
    },
  },
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
          state.bindings = Object.fromEntries(
            (message.bindings ?? []).map((binding) => [binding.workspaceId, binding.directoryPath]),
          );
          break;
        case 'curatorBindingChanged':
          if (message.directoryPath === null) {
            delete state.bindings[message.workspaceId];
          } else {
            state.bindings[message.workspaceId] = message.directoryPath;
          }
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

export const { saveStarted, saveSettled, curatorChangeStarted, curatorChangeSettled } =
  workspacesSlice.actions;
export const workspacesReducer = workspacesSlice.reducer;
