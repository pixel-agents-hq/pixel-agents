/**
 * 工作空間根目錄（P2 驗收 6、10）：欄位持久化、設定訊息、驗證、兩種 KB 區重疊拒絕、
 * 唯讀客戶端、舊版相容。臨時 HOME，不碰真實設定。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import {
  WORKSPACE_ROOT_LOCKED_REASON,
  WORKSPACE_ROOT_NOT_ABSOLUTE_REASON,
  WORKSPACE_ROOT_NOT_DIRECTORY_REASON,
  WORKSPACE_ROOT_OVERLAP_REASON,
  WORKSPACE_ROOT_WORKSPACE_OVERLAP_REASON,
} from '../src/constants.js';
import { listWorkspaces, saveWorkspace, setWorkspaceRoot } from '../src/workspaces.js';

let home: string;
let originalHome: string | undefined;
let store: AgentStateStore;
let broadcasts: Array<Record<string, unknown>>;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-root-')));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  store = new AgentStateStore();
  broadcasts = [];
  store.on('broadcast', (m) => broadcasts.push(m));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  store.dispose();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function mkdir(...parts: string[]): string {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workspace(name: string, dirs: string[] = []): string {
  const result = saveWorkspace({ name, directoryPaths: dirs });
  if (!result.ok || !result.id) throw new Error('not saved');
  return result.id;
}

const ctx = (): ClientMessageContext => ({ store, cache: null });
function send(msg: Record<string, unknown>, context = ctx()): Array<Record<string, unknown>> {
  const replies: Array<Record<string, unknown>> = [];
  handleClientMessage(msg, (m) => replies.push(m), context);
  return replies;
}
const rootOf = (id: string) => listWorkspaces().find((w) => w.id === id)?.rootPath;

describe('setWorkspaceRoot', () => {
  it('stores the realpath, rebroadcasts workspacesLoaded, and clears with null', () => {
    const root = mkdir('real-root');
    fs.symlinkSync(root, path.join(home, 'root-link'));
    const id = workspace('alpha');
    expect(
      send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath: path.join(home, 'root-link') }),
    ).toEqual([]);
    expect(rootOf(id)).toBe(root);
    expect(broadcasts.at(-1)?.type).toBe('workspacesLoaded');

    expect(send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath: null })).toEqual([]);
    expect(rootOf(id)).toBeUndefined();
  });

  it('keeps the root when the Workspace is edited through saveWorkspace', () => {
    const root = mkdir('r');
    const id = workspace('alpha');
    expect(setWorkspaceRoot({ workspaceId: id, rootPath: root }, [])).toEqual({ ok: true });
    expect(saveWorkspace({ id, name: 'renamed', directoryPaths: [] }).ok).toBe(true);
    expect(rootOf(id)).toBe(root);
  });

  it('refuses relative, tilde, missing, file and malformed roots', () => {
    const id = workspace('alpha');
    fs.writeFileSync(path.join(home, 'file'), '');
    const cases: Array<[unknown, string]> = [
      ['relative/dir', WORKSPACE_ROOT_NOT_ABSOLUTE_REASON],
      ['~/x', WORKSPACE_ROOT_NOT_ABSOLUTE_REASON],
      ['', WORKSPACE_ROOT_NOT_ABSOLUTE_REASON],
      [42, WORKSPACE_ROOT_NOT_ABSOLUTE_REASON],
      [undefined, WORKSPACE_ROOT_NOT_ABSOLUTE_REASON],
      [path.join(home, 'missing'), WORKSPACE_ROOT_NOT_DIRECTORY_REASON],
      [path.join(home, 'file'), WORKSPACE_ROOT_NOT_DIRECTORY_REASON],
    ];
    for (const [rootPath, reason] of cases) {
      expect(send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath })).toEqual([
        { type: 'workspaceRejected', reason },
      ]);
    }
    expect(send({ type: 'setWorkspaceRoot', workspaceId: 'nope', rootPath: null })[0]?.type).toBe(
      'workspaceRejected',
    );
    expect(rootOf(id)).toBeUndefined();
  });

  it('refuses a root whose .note equals, contains or sits inside a Directory .note (realpath)', () => {
    const dir = mkdir('proj');
    const id = workspace('alpha', [dir]);
    const overlap = (rootPath: string) =>
      send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath });
    const rejected = [{ type: 'workspaceRejected', reason: WORKSPACE_ROOT_OVERLAP_REASON }];

    // 相等：根目錄就是 Directory（經 symlink 也一樣）。
    expect(overlap(dir)).toEqual(rejected);
    fs.symlinkSync(dir, path.join(home, 'proj-link'));
    expect(overlap(path.join(home, 'proj-link'))).toEqual(rejected);
    // 工作空間 KB 在個人 KB 之內：根目錄位於 <dir>/.note/ 底下。
    expect(overlap(mkdir('proj', '.note', 'inner'))).toEqual(rejected);
    // 個人 KB 在工作空間 KB 之內：Directory 位於 <root>/.note/ 底下。
    const outer = mkdir('outer');
    workspace('beta', [mkdir('outer', '.note', 'agent-dir')]);
    expect(overlap(outer)).toEqual(rejected);
    // 不重疊：<root>/.note 與 <root>/sub/.note 互不包含。
    expect(overlap(home)).toEqual([]);
    expect(rootOf(id)).toBe(home);
  });

  it('refuses a root whose .note equals or nests with another Workspace root', () => {
    const first = workspace('alpha');
    const second = workspace('beta');
    const root = mkdir('shared');
    expect(send({ type: 'setWorkspaceRoot', workspaceId: first, rootPath: root })).toEqual([]);
    const rejected = [
      { type: 'workspaceRejected', reason: WORKSPACE_ROOT_WORKSPACE_OVERLAP_REASON },
    ];
    expect(send({ type: 'setWorkspaceRoot', workspaceId: second, rootPath: root })).toEqual(
      rejected,
    );
    expect(
      send({
        type: 'setWorkspaceRoot',
        workspaceId: second,
        rootPath: mkdir('shared', '.note', 'inner'),
      }),
    ).toEqual(rejected);
    expect(rootOf(second)).toBeUndefined();
    // 同一個工作空間重設自己的根目錄不算重疊。
    expect(send({ type: 'setWorkspaceRoot', workspaceId: first, rootPath: root })).toEqual([]);
  });

  it('refuses adding a Directory whose personal KB overlaps a Workspace root', () => {
    const id = workspace('alpha');
    const root = mkdir('kbroot');
    send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath: root });
    const other = workspace('beta');
    expect(saveWorkspace({ id: other, name: 'beta', directoryPaths: [root] })).toEqual({
      ok: false,
      reason: WORKSPACE_ROOT_OVERLAP_REASON,
    });
    expect(
      saveWorkspace({ id: other, name: 'beta', directoryPaths: [mkdir('elsewhere')] }).ok,
    ).toBe(true);
  });

  it('locks the root once its .note has content, and frees it while empty', () => {
    const id = workspace('alpha');
    const root = mkdir('kb-a');
    const other = mkdir('kb-b');
    const set = (rootPath: string | null) =>
      send({ type: 'setWorkspaceRoot', workspaceId: id, rootPath });
    expect(set(root)).toEqual([]);
    // .note 不存在或是空的：可以改、可以清除。
    expect(set(other)).toEqual([]);
    mkdir('kb-b', '.note');
    expect(set(root)).toEqual([]);
    fs.writeFileSync(path.join(mkdir('kb-a', '.note'), 'a.md'), 'x');
    const locked = [{ type: 'workspaceRejected', reason: WORKSPACE_ROOT_LOCKED_REASON }];
    expect(set(other)).toEqual(locked);
    expect(set(null)).toEqual(locked);
    expect(rootOf(id)).toBe(root);
    // 重設成同一個根目錄不算變更。
    expect(set(root)).toEqual([]);
  });

  it('accepts a root on the default Workspace', () => {
    const root = mkdir('r');
    expect(setWorkspaceRoot({ workspaceId: DEFAULT_WORKSPACE_ID, rootPath: root }, [])).toEqual({
      ok: true,
    });
    expect(rootOf(DEFAULT_WORKSPACE_ID)).toBe(root);
  });
});

describe('workspaces.json compatibility', () => {
  const file = () => path.join(home, '.pixel-agents', 'workspaces.json');

  it('a file written with rootPath keeps the pre-P2 shape for every other field', () => {
    const id = workspace('alpha');
    setWorkspaceRoot({ workspaceId: id, rootPath: mkdir('r') }, []);
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as {
      workspaces: Array<Record<string, unknown>>;
    };
    // 舊版解析器只取這三個欄位（型別相同），多出的 rootPath 被忽略，因此舊版照常讀取；
    // 舊版下一次寫入會把 rootPath 丟掉，新版讀到的是「未設根目錄」= 規則不啟用。
    for (const entry of raw.workspaces) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(Array.isArray(entry.directoryPaths)).toBe(true);
      expect(
        Object.keys(entry).filter((k) => !['id', 'name', 'directoryPaths'].includes(k)),
      ).toEqual(entry.id === id ? ['rootPath'] : []);
    }
    // 舊版寫回（只剩三個欄位）：新版讀到沒有根目錄。
    fs.writeFileSync(
      file(),
      JSON.stringify({
        workspaces: raw.workspaces.map(({ id: i, name, directoryPaths }) => ({
          id: i,
          name,
          directoryPaths,
        })),
      }),
    );
    expect(rootOf(id)).toBeUndefined();
  });

  it('treats a malformed rootPath like any other malformed field (file untrusted)', () => {
    const id = workspace('alpha');
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as {
      workspaces: Array<Record<string, unknown>>;
    };
    for (const bad of ['relative', 7, '']) {
      fs.writeFileSync(
        file(),
        JSON.stringify({
          workspaces: raw.workspaces.map((w) => (w.id === id ? { ...w, rootPath: bad } : w)),
        }),
      );
      expect(listWorkspaces().map((w) => w.id)).toEqual([DEFAULT_WORKSPACE_ID]);
    }
  });
});
