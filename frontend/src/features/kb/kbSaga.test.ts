import { runSaga, stdChannel } from 'redux-saga';
import { describe, expect, it } from 'vitest';

import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { kbSaga } from './kbSaga';
import {
  EMPTY_KB_VIEW,
  kbDirectoryChanged,
  kbFileSelected,
  kbListRequested,
  kbReducer,
} from './kbSlice';

const AGENT = { scope: 'agent', agentId: 12 } as const;
const WORKSPACE = { scope: 'workspace', workspaceId: 'ws-1' } as const;

function start(connection = { status: 'connected' }) {
  const dispatched: unknown[] = [];
  const channel = stdChannel();
  const task = runSaga(
    {
      channel,
      dispatch: (action: unknown) => {
        dispatched.push(action);
        channel.put(action as { type: string });
      },
      getState: () => ({ connection }),
    },
    kbSaga,
  );
  return { channel, dispatched, task };
}

const sent = (dispatched: unknown[]) =>
  dispatched.filter(clientMessageRequested.match).map((action) => action.payload);

describe('kbSaga', () => {
  it('列出請求送出 listKbFiles', () => {
    const { channel, dispatched, task } = start();
    channel.put(kbListRequested(AGENT));
    expect(sent(dispatched)).toEqual([{ type: 'listKbFiles', target: AGENT }]);
    task.cancel();
  });

  it('未連線時不送請求', () => {
    const { channel, dispatched, task } = start({ status: 'reconnecting' });
    channel.put(kbListRequested(AGENT));
    expect(sent(dispatched)).toEqual([]);
    task.cancel();
  });

  it('讀檔一次只送一個，等回覆後才送最後一次選擇', () => {
    const { channel, dispatched, task } = start();
    channel.put(kbFileSelected({ target: AGENT, relPath: 'a.md' }));
    channel.put(kbFileSelected({ target: AGENT, relPath: 'b.md' }));
    channel.put(kbFileSelected({ target: AGENT, relPath: 'c.md' }));
    expect(sent(dispatched)).toEqual([{ type: 'readKbFile', target: AGENT, relPath: 'a.md' }]);
    channel.put(
      serverMessageReceived({ type: 'kbFileRead', target: AGENT, relPath: 'a.md', content: 'x' }),
    );
    expect(sent(dispatched)).toEqual([
      { type: 'readKbFile', target: AGENT, relPath: 'a.md' },
      { type: 'readKbFile', target: AGENT, relPath: 'c.md' },
    ]);
    task.cancel();
  });
});

describe('kbReducer', () => {
  const empty = { byKey: {} };
  const listed = (state = empty) =>
    kbReducer(
      state,
      serverMessageReceived({
        type: 'kbFilesListed',
        target: AGENT,
        files: [{ path: 'a.md', size: 3 }],
        truncated: false,
      }),
    );

  it('listed 依 target 存檔案清單，互不干擾', () => {
    const state = listed();
    expect(state.byKey['agent:12']).toMatchObject({
      listed: true,
      files: [{ path: 'a.md', size: 3 }],
    });
    expect(state.byKey['workspace:ws-1']).toBeUndefined();
  });

  it('選檔後收到內容', () => {
    let state = kbReducer(listed(), kbFileSelected({ target: AGENT, relPath: 'a.md' }));
    expect(state.byKey['agent:12']).toMatchObject({ reading: true, selectedPath: 'a.md' });
    state = kbReducer(
      state,
      serverMessageReceived({ type: 'kbFileRead', target: AGENT, relPath: 'a.md', content: 'hi' }),
    );
    expect(state.byKey['agent:12']).toMatchObject({ reading: false, content: 'hi' });
  });

  it('過時的讀檔回覆被忽略', () => {
    let state = kbReducer(listed(), kbFileSelected({ target: AGENT, relPath: 'a.md' }));
    state = kbReducer(state, kbFileSelected({ target: AGENT, relPath: 'b.md' }));
    state = kbReducer(
      state,
      serverMessageReceived({ type: 'kbFileRead', target: AGENT, relPath: 'a.md', content: 'old' }),
    );
    expect(state.byKey['agent:12']).toMatchObject({
      selectedPath: 'b.md',
      reading: true,
      content: null,
    });
  });

  it('讀檔被拒絕記錄原因；清單被拒絕記在清單', () => {
    let state = kbReducer(listed(), kbFileSelected({ target: AGENT, relPath: 'a.md' }));
    state = kbReducer(
      state,
      serverMessageReceived({
        type: 'kbRejected',
        target: AGENT,
        relPath: 'a.md',
        reason: 'too_large',
      }),
    );
    expect(state.byKey['agent:12']).toMatchObject({ reading: false, readError: 'too_large' });
    state = kbReducer(
      state,
      serverMessageReceived({ type: 'kbRejected', target: WORKSPACE, reason: 'not_found' }),
    );
    expect(state.byKey['workspace:ws-1']).toMatchObject({ listError: 'not_found' });
  });

  it('沒有 target 的拒絕被忽略；連線中斷清掉狀態', () => {
    let state = kbReducer(
      listed(),
      serverMessageReceived({ type: 'kbRejected', reason: 'unsafe' }),
    );
    expect(Object.keys(state.byKey)).toEqual(['agent:12']);
    state = kbReducer(state, { type: 'connection/statusChanged', payload: 'reconnecting' });
    expect(state.byKey).toEqual({});
    expect(EMPTY_KB_VIEW.listed).toBe(false);
  });

  describe('目錄導覽', () => {
    const selected = () =>
      kbReducer(listed(), kbFileSelected({ target: AGENT, relPath: 'sub/a.md' }));

    it('預設在根目錄；進入與回上一層會清掉選取與內容', () => {
      expect(listed().byKey['agent:12'].dir).toBe('');
      let state = kbReducer(
        selected(),
        serverMessageReceived({
          type: 'kbFileRead',
          target: AGENT,
          relPath: 'sub/a.md',
          content: 'x',
        }),
      );
      state = kbReducer(state, kbDirectoryChanged({ target: AGENT, dir: 'sub' }));
      expect(state.byKey['agent:12']).toMatchObject({
        dir: 'sub',
        selectedPath: null,
        content: null,
        reading: false,
        readError: null,
      });
      state = kbReducer(state, kbDirectoryChanged({ target: AGENT, dir: '' }));
      expect(state.byKey['agent:12'].dir).toBe('');
    });

    it('切換目錄後，舊檔案的讀檔回覆被忽略', () => {
      let state = kbReducer(selected(), kbDirectoryChanged({ target: AGENT, dir: 'sub' }));
      state = kbReducer(
        state,
        serverMessageReceived({
          type: 'kbFileRead',
          target: AGENT,
          relPath: 'sub/a.md',
          content: 'old',
        }),
      );
      expect(state.byKey['agent:12']).toMatchObject({ selectedPath: null, content: null });
    });

    it('重新列出（target 改變或重連）回到根目錄；連線中斷清空', () => {
      let state = kbReducer(selected(), kbDirectoryChanged({ target: AGENT, dir: 'sub' }));
      state = kbReducer(state, kbListRequested(AGENT));
      expect(state.byKey['agent:12']).toMatchObject({ dir: '', selectedPath: null });
      state = kbReducer(state, kbDirectoryChanged({ target: AGENT, dir: 'sub' }));
      state = kbReducer(state, { type: 'connection/statusChanged', payload: 'reconnecting' });
      expect(state.byKey).toEqual({});
    });

    it('目錄各 target 互不干擾', () => {
      const state = kbReducer(listed(), kbDirectoryChanged({ target: WORKSPACE, dir: 'x' }));
      expect(state.byKey['agent:12'].dir).toBe('');
      expect(state.byKey['workspace:ws-1'].dir).toBe('x');
    });
  });
});
