import { configureStore } from '@reduxjs/toolkit';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { DashboardPage } from '../../pages/DashboardPage';
import { WorkspaceSettingsPage, WorkspaceSettingsView } from '../../pages/WorkspaceSettingsPage';
import { agentsReducer } from '../agents/agentsSlice';
import { connectionReducer } from '../connection/connectionSlice';
import { kbReducer } from '../kb/kbSlice';
import { workspacesReducer } from './workspacesSlice';
import { WORKSPACE_ROOT_TEXT, WORKSPACE_SETTINGS_TEXT } from '../../constants';
import type { Directory, Workspace } from '../../protocol';
import {
  buildSavePayload,
  canEditRootPath,
  canSaveSettings,
  directoryOptions,
  draftFromWorkspace,
  isDirty,
  kbViewIsEmpty,
  removesDirectories,
  toggleDirectory,
} from './workspaceSettings';

const ws = (id: string, directoryPaths: string[], rootPath?: string, name = id): Workspace => ({
  id,
  name,
  directoryPaths,
  ...(rootPath === undefined ? {} : { rootPath }),
});
const dir = (name: string, path: string): Directory => ({ name, path, source: 'user' });

const directories = [dir('A', '/a'), dir('B', '/b/'), dir('C', '/c'), dir('Root', '/root')];
const current = ws('w1', ['/a'], '/root');
const other = ws('w2', ['/b']);
const everyone = [ws('default', ['/c']), current, other];

function renderWithStore(ui: ReactNode, workspaces: Workspace[], readOnly = false) {
  const initial = workspacesReducer(undefined, { type: 'init' });
  const store = configureStore({
    reducer: {
      connection: connectionReducer,
      workspaces: workspacesReducer,
      agents: agentsReducer,
      kb: kbReducer,
    },
    preloadedState: {
      connection: { ...connectionReducer(undefined, { type: 'init' }), readOnly },
      workspaces: { ...initial, workspaces, directories },
    },
  });
  return renderToStaticMarkup(<Provider store={store}>{ui}</Provider>);
}

describe('directoryOptions', () => {
  const options = directoryOptions(directories, everyone, current, ['/a']);

  it('預先勾選目前包含的目錄', () => {
    expect(options.find((o) => o.directory.name === 'A')?.checked).toBe(true);
    expect(options.find((o) => o.directory.name === 'C')?.checked).toBe(false);
  });
  it('其他工作空間擁有的標示擁有者（尾端斜線不影響），Default 不算擁有者', () => {
    expect(options.find((o) => o.directory.name === 'B')?.ownerName).toBe('w2');
    expect(options.find((o) => o.directory.name === 'C')?.ownerName).toBeUndefined();
    expect(options.find((o) => o.directory.name === 'A')?.ownerName).toBeUndefined();
  });
  it('不提供工作空間根目錄', () => {
    expect(options.map((o) => o.directory.name)).not.toContain('Root');
  });
});

describe('dirty 與儲存條件', () => {
  const base = draftFromWorkspace(current);
  it('未變更不是 dirty，名稱前後空白不算變更', () => {
    expect(isDirty(current, base)).toBe(false);
    expect(isDirty(current, { ...base, name: ' w1 ' })).toBe(false);
  });
  it('名稱或目錄集合改變是 dirty', () => {
    expect(isDirty(current, { ...base, name: 'x' })).toBe(true);
    expect(isDirty(current, toggleDirectory(base, '/c', true))).toBe(true);
    expect(isDirty(current, toggleDirectory(base, '/a/', false))).toBe(true);
  });
  it('根目錄改變或清空也是 dirty，前後空白不算', () => {
    expect(isDirty(current, { ...base, rootPath: ' /root ' })).toBe(false);
    expect(isDirty(current, { ...base, rootPath: '/other' })).toBe(true);
    expect(isDirty(current, { ...base, rootPath: '' })).toBe(true);
    expect(isDirty(other, { ...draftFromWorkspace(other), rootPath: '/new' })).toBe(true);
  });
  it('根目錄只在沒設定過、或知識庫是空的時才能編輯', () => {
    expect(canEditRootPath(other, undefined)).toBe(true);
    expect(canEditRootPath(current, true)).toBe(true);
    expect(canEditRootPath(current, false)).toBe(false);
    expect(canEditRootPath(current, undefined)).toBe(false);
  });
  it('知識庫為空 = 清單回來且沒有檔案，或資料夾還沒建立；讀不到時不算空', () => {
    const view = { listed: true, files: [], listError: null };
    expect(kbViewIsEmpty(undefined)).toBeUndefined();
    expect(kbViewIsEmpty({ ...view, listed: false })).toBeUndefined();
    expect(kbViewIsEmpty(view)).toBe(true);
    expect(kbViewIsEmpty({ ...view, files: [{}] })).toBe(false);
    expect(kbViewIsEmpty({ ...view, listError: 'not_found' })).toBe(true);
    expect(kbViewIsEmpty({ ...view, listError: 'unavailable' })).toBeUndefined();
  });
  it('未變更、唯讀、空名稱、pending、Default 都不可儲存', () => {
    const changed = { ...base, name: 'x' };
    expect(canSaveSettings(current, changed, false, false)).toBe(true);
    expect(canSaveSettings(current, base, false, false)).toBe(false);
    expect(canSaveSettings(current, changed, true, false)).toBe(false);
    expect(canSaveSettings(current, { ...base, name: '  ' }, false, false)).toBe(false);
    expect(canSaveSettings(current, changed, false, true)).toBe(false);
    expect(canSaveSettings(ws('default', []), changed, false, false)).toBe(false);
  });
  it('移除目錄時 removesDirectories 為真', () => {
    expect(removesDirectories(current, base)).toBe(false);
    expect(removesDirectories(current, toggleDirectory(base, '/a', false))).toBe(true);
  });
});

describe('buildSavePayload', () => {
  it('只帶 id、名稱、目錄，不帶 rootPath 與 permissionRoles', () => {
    const payload = buildSavePayload('w1', { name: ' n ', directoryPaths: ['/a'], rootPath: '/r' });
    expect(payload).toEqual({
      type: 'saveWorkspace',
      id: 'w1',
      name: 'n',
      directoryPaths: ['/a'],
    });
    expect(payload).not.toHaveProperty('rootPath');
    expect(payload).not.toHaveProperty('permissionRoles');
  });
});

describe('WorkspaceSettingsView 標記', () => {
  const render = (patch: Partial<Parameters<typeof WorkspaceSettingsView>[0]> = {}) =>
    renderWithStore(
      <MemoryRouter>
        <WorkspaceSettingsView
          workspace={current}
          directories={directories}
          workspaces={everyone}
          draft={draftFromWorkspace(current)}
          readOnly={false}
          pending={false}
          kbIsEmpty={true}
          onDraftChange={() => {}}
          onSave={() => {}}
          {...patch}
        />
      </MemoryRouter>,
      everyone,
    );

  it('顯示名稱、目錄清單與擁有者標示，擁有的項目 disabled', () => {
    const html = render();
    expect(html).toContain('value="w1"');
    expect(html).toContain(WORKSPACE_SETTINGS_TEXT.directoriesLabel);
    expect(html).toContain(`${WORKSPACE_SETTINGS_TEXT.ownedByPrefix}w2`);
    expect(html).toContain('/c');
    expect(html).toContain('Mui-disabled');
  });
  it('未變更時儲存鈕 disabled，唯讀顯示提示', () => {
    expect(render()).toMatch(/<button[^>]*disabled[^>]*>儲存/);
    expect(render({ readOnly: true })).toContain(WORKSPACE_SETTINGS_TEXT.readOnly);
  });
  it('根目錄欄位：知識庫有內容時鎖住並說明，空的才開放；只有一個儲存鈕', () => {
    const locked = render({ kbIsEmpty: false });
    expect(locked).toContain(WORKSPACE_ROOT_TEXT.locked);
    expect(render({ kbIsEmpty: undefined })).toContain(WORKSPACE_ROOT_TEXT.checking);
    expect(render({ kbIsEmpty: true })).not.toContain(WORKSPACE_ROOT_TEXT.locked);
    expect(locked.match(/>儲存</g)).toHaveLength(1);
    expect(locked).not.toContain('>設定</button>');
    expect(locked).not.toContain('>清除</button>');
  });
  it('名稱含 HTML 時被跳脫', () => {
    const evil = ws('w3', [], undefined, '<img src=x onerror=alert(1)>');
    const html = render({
      workspace: evil,
      draft: draftFromWorkspace(evil),
      directories: [dir('<img onerror=1>', '/x')],
      workspaces: [evil, ws('w4', ['/x'], undefined, '<b onerror=1>')],
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b onerror');
    expect(html).toContain('&lt;img');
  });
});

describe('頁面守衛與標頭', () => {
  const settingsRoute = (path: string, workspaces: Workspace[]) =>
    renderWithStore(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/w/:workspaceId/settings" element={<WorkspaceSettingsPage />} />
        </Routes>
      </MemoryRouter>,
      workspaces,
    );
  const dashboard = (id: string) =>
    renderWithStore(
      <MemoryRouter initialEntries={[`/w/${id}`]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
      everyone,
    );

  it('一般工作空間顯示設定頁，Default 與未知 id 顯示守衛', () => {
    expect(settingsRoute('/w/w1/settings', everyone)).toContain(WORKSPACE_SETTINGS_TEXT.title);
    expect(settingsRoute('/w/default/settings', everyone)).toContain(
      WORKSPACE_SETTINGS_TEXT.unavailable,
    );
    expect(settingsRoute('/w/nope/settings', everyone)).toContain(
      WORKSPACE_SETTINGS_TEXT.unavailable,
    );
  });
  it('標頭只在非 Default 顯示設定連結，且不再渲染根目錄控制', () => {
    const normal = dashboard('w1');
    expect(normal).toContain('href="/w/w1/settings"');
    expect(normal).not.toContain(WORKSPACE_ROOT_TEXT.inputLabel);
    expect(dashboard('default')).not.toContain('/settings"');
  });
  it('設定頁含根目錄控制', () => {
    expect(settingsRoute('/w/w1/settings', everyone)).toContain(WORKSPACE_ROOT_TEXT.inputLabel);
  });
});
