import { createAction, createSlice } from '@reduxjs/toolkit';

import { KB_ROOT_DIR } from '../../components/kb/kbTree';
import { serverMessageReceived } from '../connection/actions';
import { statusChanged } from '../connection/connectionSlice';
import type { KbFileEntry, KbRejectionReason, KbTarget } from '../../protocol';

export interface KbView {
  /** 已收到檔案清單 */
  listed: boolean;
  files: KbFileEntry[];
  truncated: boolean;
  listError: KbRejectionReason | null;
  /** 目前所在目錄，根目錄為 ''，其餘 'a/b' */
  dir: string;
  selectedPath: string | null;
  reading: boolean;
  content: string | null;
  readError: KbRejectionReason | null;
}

interface KbState {
  byKey: Record<string, KbView>;
}

export const EMPTY_KB_VIEW: KbView = {
  listed: false,
  files: [],
  truncated: false,
  listError: null,
  dir: KB_ROOT_DIR,
  selectedPath: null,
  reading: false,
  content: null,
  readError: null,
};

const initialState: KbState = { byKey: {} };

/** 同一個 target 永遠得到同一個 key，回覆靠它對回請求。 */
export function kbTargetKey(target: KbTarget): string {
  return target.scope === 'agent' ? `agent:${target.agentId}` : `workspace:${target.workspaceId}`;
}

export const kbListRequested = createAction<KbTarget>('kb/listRequested');
export const kbFileSelected = createAction<{ target: KbTarget; relPath: string }>(
  'kb/fileSelected',
);
export const kbDirectoryChanged = createAction<{ target: KbTarget; dir: string }>(
  'kb/directoryChanged',
);

function clearSelection(view: KbView) {
  view.selectedPath = null;
  view.reading = false;
  view.content = null;
  view.readError = null;
}

function viewOf(state: KbState, target: KbTarget): KbView {
  const key = kbTargetKey(target);
  state.byKey[key] ??= { ...EMPTY_KB_VIEW };
  return state.byKey[key];
}

const kbSlice = createSlice({
  name: 'kb',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(kbListRequested, (state, { payload: target }) => {
        const view = viewOf(state, target);
        view.listed = false;
        view.listError = null;
        // target 改變或重新連線都從根目錄開始，不留別處的位置與內容
        view.dir = KB_ROOT_DIR;
        clearSelection(view);
      })
      .addCase(kbDirectoryChanged, (state, { payload }) => {
        const view = viewOf(state, payload.target);
        view.dir = payload.dir;
        clearSelection(view);
      })
      .addCase(kbFileSelected, (state, { payload }) => {
        const view = viewOf(state, payload.target);
        view.selectedPath = payload.relPath;
        view.reading = true;
        view.content = null;
        view.readError = null;
      })
      // 連線一斷，之前的清單與內容都不再可信；重連後由容器重新列出
      .addCase(statusChanged, (state, { payload: status }) => {
        if (status !== 'connected') state.byKey = {};
      })
      .addCase(serverMessageReceived, (state, { payload: message }) => {
        switch (message.type) {
          case 'kbFilesListed': {
            const view = viewOf(state, message.target);
            view.listed = true;
            view.files = message.files;
            view.truncated = message.truncated;
            view.listError = null;
            break;
          }
          case 'kbFileRead': {
            const view = viewOf(state, message.target);
            // 使用者已改點別的檔案，這是過時的回覆
            if (view.selectedPath !== message.relPath) break;
            view.reading = false;
            view.content = message.content;
            view.readError = null;
            break;
          }
          case 'kbRejected': {
            if (!message.target) break;
            const view = viewOf(state, message.target);
            if (message.relPath === undefined) {
              view.listed = true;
              view.files = [];
              view.listError = message.reason;
            } else if (view.selectedPath === message.relPath) {
              view.reading = false;
              view.content = null;
              view.readError = message.reason;
            }
            break;
          }
        }
      });
  },
});

export const kbReducer = kbSlice.reducer;
