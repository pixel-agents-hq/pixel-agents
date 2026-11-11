import { configureStore } from '@reduxjs/toolkit';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { KbWriterControl } from '../../components/KbWriterControl';
import { KbWriterVacancy, KbWriterVacancyView } from '../../components/KbWriterVacancy';
import { AddWorkspacePage } from '../../pages/AddWorkspacePage';
import { ADD_WORKSPACE_TEXT, CURATOR_TEXT } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { ServerMessage } from '../../protocol';
import { agentsReducer } from '../agents/agentsSlice';
import type { Agent } from '../agents/agentsSlice';
import { serverMessageReceived } from '../connection/actions';
import { connectionReducer } from '../connection/connectionSlice';
import { curatorPersistenceNote, directoryLabel, vacantBindingPath } from './curatorBinding';
import { selectableDirectoryPaths } from './workspaceRoot';
import { workspacesReducer } from './workspacesSlice';

function storeWith(messages: ServerMessage[]) {
  const store = configureStore({
    reducer: {
      connection: connectionReducer,
      workspaces: workspacesReducer,
      agents: agentsReducer,
    },
  });
  for (const message of messages) store.dispatch(serverMessageReceived(message));
  return store;
}

const reduce = (...messages: ServerMessage[]) => storeWith(messages).getState().workspaces;
const loaded = (extra: Partial<Extract<ServerMessage, { type: 'curatorsLoaded' }>> = {}) =>
  ({ type: 'curatorsLoaded', available: true, curators: [], ...extra }) as ServerMessage;
const directories = (): ServerMessage => ({
  type: 'directoriesLoaded',
  directories: [{ name: 'proj', path: '/real/proj', source: 'user' }],
});

const vacancyHtml = (store: ReturnType<typeof storeWith>, workspaceId: string) =>
  renderToStaticMarkup(
    <Provider store={store}>
      <KbWriterVacancy workspaceId={workspaceId} />
    </Provider>,
  );

describe('bindings 狀態', () => {
  it('curatorsLoaded 帶 bindings 就存下，缺少時視為空', () => {
    expect(
      reduce(loaded({ bindings: [{ workspaceId: 'w', directoryPath: '/d' }] })).bindings,
    ).toEqual({ w: '/d' });
    expect(reduce(loaded()).bindings).toEqual({});
    expect(
      reduce(loaded({ bindings: [{ workspaceId: 'w', directoryPath: '/d' }] }), loaded()).bindings,
    ).toEqual({});
  });

  it('curatorBindingChanged 設定與清除', () => {
    const set = { type: 'curatorBindingChanged', workspaceId: 'w', directoryPath: '/d' } as const;
    expect(reduce(set).bindings).toEqual({ w: '/d' });
    expect(
      reduce(set, { type: 'curatorBindingChanged', workspaceId: 'w', directoryPath: null })
        .bindings,
    ).toEqual({});
  });
});

describe('KB Writer 職缺', () => {
  const binding = {
    type: 'curatorBindingChanged',
    workspaceId: 'w',
    directoryPath: '/real/proj',
  } as const;

  it('沒有 curator、有綁定、非 Default 才算職缺', () => {
    expect(vacantBindingPath('w', {}, { w: '/d' })).toBe('/d');
    expect(vacantBindingPath('w', { w: 1 }, { w: '/d' })).toBeUndefined();
    expect(vacantBindingPath('w', {}, {})).toBeUndefined();
    expect(
      vacantBindingPath(DEFAULT_WORKSPACE_ID, {}, { [DEFAULT_WORKSPACE_ID]: '/d' }),
    ).toBeUndefined();
  });

  it('顯示職缺說明與撤銷綁定；名稱取自登記的目錄，沒有就顯示路徑', () => {
    const html = vacancyHtml(storeWith([loaded(), directories(), binding]), 'w');
    expect(html).toContain(`${CURATOR_TEXT.vacancyPrefix}proj${CURATOR_TEXT.vacancySuffix}`);
    expect(html).toContain(CURATOR_TEXT.revoke);

    const noName = vacancyHtml(
      storeWith([loaded(), { ...binding, directoryPath: '/unregistered' } as ServerMessage]),
      'w',
    );
    expect(noName).toContain('/unregistered');
    expect(directoryLabel([], '/x')).toBe('/x');
  });

  it('有 curator、Default、主機不支援時都不顯示', () => {
    const withCurator = loaded({ curators: [{ workspaceId: 'w', agentId: 1 }] });
    expect(vacancyHtml(storeWith([withCurator, binding]), 'w')).toBe('');
    expect(
      vacancyHtml(
        storeWith([loaded(), { ...binding, workspaceId: DEFAULT_WORKSPACE_ID } as ServerMessage]),
        DEFAULT_WORKSPACE_ID,
      ),
    ).toBe('');
    expect(vacancyHtml(storeWith([loaded({ available: false }), binding]), 'w')).toBe('');
  });

  it('View 顯示撤銷綁定按鈕', () => {
    const html = renderToStaticMarkup(
      <KbWriterVacancyView directoryName="d" pending={false} onRevoke={() => {}} />,
    );
    expect(html).toContain(CURATOR_TEXT.revoke);
  });
});

describe('KB Writer 非持久說明', () => {
  it('Default 維持不會持久保存，其他工作空間才說會自動恢復', () => {
    expect(curatorPersistenceNote(DEFAULT_WORKSPACE_ID)).toBe(CURATOR_TEXT.notPersisted);
    expect(curatorPersistenceNote('w')).toBe(CURATOR_TEXT.persistedRestore);
  });

  it('KbWriterControl 依工作空間顯示對應說明', () => {
    const agent = { id: 1, stopped: false, isExternal: false, workspaceId: 'w' } as Agent;
    const render = (workspaceId: string) =>
      renderToStaticMarkup(
        <Provider store={storeWith([loaded()])}>
          <KbWriterControl agent={{ ...agent, workspaceId }} />
        </Provider>,
      );
    expect(render('w')).toContain(CURATOR_TEXT.persistedRestore);
    expect(render('w')).not.toContain(CURATOR_TEXT.notPersisted);
    expect(render(DEFAULT_WORKSPACE_ID)).toContain(CURATOR_TEXT.notPersisted);
    expect(render(DEFAULT_WORKSPACE_ID)).not.toContain(CURATOR_TEXT.persistedRestore);
  });
});

describe('AddWorkspacePage', () => {
  it('欄位是根目錄並說明 .note/ 位置', () => {
    const html = renderToStaticMarkup(
      <Provider store={storeWith([])}>
        <MemoryRouter>
          <AddWorkspacePage />
        </MemoryRouter>
      </Provider>,
    );
    expect(html).toContain('根目錄');
    expect(html).toContain(ADD_WORKSPACE_TEXT.rootHint.replace('；', '；'));
    expect(html).toContain('setWorkspaceRoot');
    expect(html).not.toContain('saveDirectory');
  });
});

describe('selectableDirectoryPaths', () => {
  it('排除與根目錄相等的路徑（含結尾斜線），保留其他，包含關係不排除', () => {
    const paths = ['/w/root', '/w/root/sub', '/w/other'];
    expect(selectableDirectoryPaths(paths, '/w/root')).toEqual(['/w/root/sub', '/w/other']);
    expect(selectableDirectoryPaths(paths, '/w/root/')).toEqual(['/w/root/sub', '/w/other']);
    expect(selectableDirectoryPaths(['/w/root/'], '/w/root')).toEqual([]);
    expect(selectableDirectoryPaths(paths, undefined)).toEqual(paths);
    expect(selectableDirectoryPaths(['/w/Root'], '/w/root')).toEqual(['/w/Root']);
  });
});
