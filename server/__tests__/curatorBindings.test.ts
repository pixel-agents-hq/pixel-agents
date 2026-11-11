import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { createAgentState } from '../src/agentState.js';
import type { ClientMessageContext } from '../src/clientMessageHandler.js';
import {
  CURATOR_BINDING_REMOVE_FAILED_REASON,
  CURATOR_BINDING_SAVE_FAILED_REASON,
  CURATOR_BINDINGS_FILE_MAX_BYTES,
  CURATOR_BINDINGS_MAX_ENTRIES,
} from '../src/constants.js';
import {
  bindingMatchesAgent,
  type CuratorBinding,
  curatorBindingsFilePath,
  CuratorBindingStore,
  type CuratorBindingWriter,
  writeCuratorBindingsFile,
} from '../src/curatorBindings.js';
import { CuratorTable } from '../src/curators.js';
import { saveUserDirectory } from '../src/directories.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';
import { listWorkspaces, saveWorkspace, workspaceContainsDirectory } from '../src/workspaces.js';
import { createPathNormalizer } from '../src/writeGuard/pathNormalization.js';
import { KbHarness } from './curatorHarness.js';

/**
 * KB Writer 綁定（curator-bindings.json）：重啟後由操作者在綁定的 Directory 啟動
 * agent 時自動恢復。一律走 handleClientMessage，搭配真的 store、runtime、PTY 管理器
 * （假的 PTY 模組）與暫存 $HOME 下的真實檔案；「重啟」是以同一份檔案重新 load 一個
 * 新的綁定表與 curator 表。
 */

const SERVER_SRC = path.resolve(__dirname, '../src');

class BindingHarness extends KbHarness {
  bindings: CuratorBindingStore;
  table: CuratorTable;
  /** 測試可切換：true 時每次寫入都失敗。 */
  failWrites = false;
  /** 依序記錄每個 store 事件與廣播（檢查順序）。 */
  readonly events: string[] = [];

  constructor(private readonly writer?: CuratorBindingWriter) {
    super();
    this.bindings = this.newBindingStore();
    this.table = this.newTable(this.bindings);
    this.store.on('agentAdded', (id) => this.events.push(`agentAdded:${id}`));
    this.store.on('broadcast', (m) =>
      this.events.push(`${String(m.type)}:${String(m.agentId ?? m.workspaceId ?? '')}`),
    );
  }

  private newBindingStore(): CuratorBindingStore {
    return new CuratorBindingStore({
      broadcast: (message) => this.store.broadcast(message),
      write: async (filePath, data) => {
        if (this.failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        await (this.writer ?? writeCuratorBindingsFile)(filePath, data);
      },
    });
  }

  private newTable(bindings: CuratorBindingStore): CuratorTable {
    return new CuratorTable({
      store: this.store,
      ptyManager: this.manager,
      broadcast: (message) => this.store.broadcast(message),
      bindings,
    });
  }

  /** 模擬重啟：新的綁定表從磁碟載入，新的 curator 表（記憶體中沒有 curator）。 */
  async restart(): Promise<void> {
    await this.bindings.flush();
    this.bindings = this.newBindingStore();
    await this.bindings.load();
    this.table = this.newTable(this.bindings);
  }

  ctxB(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return this.ctx({ curators: this.table, ...overrides });
  }

  sendB(msg: Record<string, unknown>): Array<Record<string, unknown>> {
    return this.send(msg, this.ctxB());
  }

  /** 經由 launchAgent 處理器啟動；回傳新 agent 的 id（沒啟動則 null）。 */
  launchVia(directoryPath: string | undefined): number | null {
    const before = this.spawned.length;
    this.sendB({ type: 'launchAgent', directoryPath });
    return this.spawned.length > before ? this.store.nextAgentId.current - 1 : null;
  }

  /** 讓最後一個 PTY 自行結束（agent 結束：store 移除它）。 */
  exitLast(): void {
    this.spawned[this.spawned.length - 1].pty.exit(0);
  }

  bindingBroadcasts(): Array<Record<string, unknown>> {
    return this.broadcasts.filter((m) => m.type === 'curatorBindingChanged');
  }

  fileBindings(): unknown {
    const file = curatorBindingsFilePath();
    if (!fs.existsSync(file)) return undefined;
    return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { bindings: unknown }).bindings;
  }
}

describe('Curator bindings', () => {
  let h: BindingHarness;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h = new BindingHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.dispose();
  });

  const set = (workspaceId: unknown, agentId: unknown) =>
    h.sendB({ type: 'setWorkspaceCurator', workspaceId, agentId });
  const unset = (workspaceId: unknown) => h.sendB({ type: 'unsetWorkspaceCurator', workspaceId });

  // ── 指定、重啟、自動恢復 ─────────────────────────────────────

  it('restores a Directory registered through a symlink after a restart, and a saveWorkspace that keeps the paths keeps the binding', async () => {
    const real = path.join(h.tempHome, 'real-repo');
    fs.mkdirSync(real);
    const link = path.join(h.tempHome, 'link-repo');
    fs.symlinkSync(real, link);
    const saved = saveWorkspace({ name: 'alpha', directoryPaths: [link] });
    expect(saved.ok).toBe(true);
    const wsId = saved.id!;

    const first = h.launchVia(link)!;
    expect(h.store.get(first)!.directoryRealPath).toBe(fs.realpathSync(link));
    expect(set(wsId, first)).toEqual([]);
    expect(await h.bindings.flush()).toBe(true);
    expect(h.fileBindings()).toEqual([{ workspaceId: wsId, directoryPath: real }]);
    expect(h.bindingBroadcasts()).toEqual([
      { type: 'curatorBindingChanged', workspaceId: wsId, directoryPath: real },
    ]);
    const mode = fs.statSync(curatorBindingsFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);

    // 不改 directoryPaths 的 saveWorkspace（改名）：綁定保留、沒有 curatorBindingChanged。
    const before = h.bindingBroadcasts().length;
    expect(
      h.sendB({ type: 'saveWorkspace', id: wsId, name: 'alpha 2', directoryPaths: [link] }),
    ).toEqual([]);
    await h.bindings.flush();
    expect(h.bindingBroadcasts()).toHaveLength(before);
    expect(h.bindings.get(wsId)).toEqual({ workspaceId: wsId, directoryPath: real });

    // agent 結束：curator 清空，綁定不動。
    h.exitLast();
    expect(h.table.curatorOf(wsId)).toBeNull();
    expect(h.bindings.has(wsId)).toBe(true);

    await h.restart();
    expect(h.table.curatorOf(wsId)).toBeNull();
    const eventsBefore = h.events.length;
    const second = h.launchVia(link)!;
    expect(h.table.curatorOf(wsId)).toBe(second);

    // 順序：agentAdded（= agentCreated）→ terminalSessionOpened → workspaceCuratorChanged。
    const events = h.events.slice(eventsBefore);
    const added = events.indexOf(`agentAdded:${second}`);
    const opened = events.indexOf(`terminalSessionOpened:${second}`);
    const changed = events.indexOf(`workspaceCuratorChanged:${second}`);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThan(added);
    expect(changed).toBeGreaterThan(opened);
  });

  it('first matching agent wins; a second launch in the bound Directory is not appointed', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    h.exitLast();
    await h.restart();
    const b = h.launchVia(ws.dir)!;
    const c = h.launchVia(ws.dir)!;
    expect(h.table.curatorOf(ws.id)).toBe(b);
    expect(c).not.toBe(b);
  });

  it('handshake curatorsLoaded carries the bindings (no roleId)', async () => {
    const ws = h.workspace('alpha');
    h.bindings.set({ workspaceId: ws.id, directoryPath: ws.dir, roleId: 'writer.md' });
    await h.bindings.flush();
    const replies = h.send({ type: 'webviewReady' }, h.ctxB());
    const loaded = replies.find((m) => m.type === 'curatorsLoaded');
    expect(loaded).toEqual({
      type: 'curatorsLoaded',
      available: true,
      curators: [],
      bindings: [{ workspaceId: ws.id, directoryPath: ws.dir }],
    });
    // 沒有 curator 表（VS Code 嵌入）：空的。
    const embedded = h.send({ type: 'webviewReady' }, h.ctx({ curators: undefined }));
    expect(embedded.find((m) => m.type === 'curatorsLoaded')).toMatchObject({ bindings: [] });
  });

  // ── 解除 ─────────────────────────────────────────────────────

  it('unset with a vacant slot but a binding succeeds, removes the binding, and a later launch is not appointed', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    h.exitLast();
    expect(h.table.curatorOf(ws.id)).toBeNull();
    expect(h.bindings.has(ws.id)).toBe(true);

    const broadcastsBefore = h.broadcasts.length;
    expect(unset(ws.id)).toEqual([]);
    expect(h.broadcasts.slice(broadcastsBefore)).toEqual([
      { type: 'workspaceCuratorChanged', workspaceId: ws.id, agentId: null },
      { type: 'curatorBindingChanged', workspaceId: ws.id, directoryPath: null },
    ]);
    expect(h.bindings.has(ws.id)).toBe(false);
    expect(await h.bindings.flush()).toBe(true);
    expect(h.fileBindings()).toEqual([]);

    h.launchVia(ws.dir);
    expect(h.table.curatorOf(ws.id)).toBeNull();
    await h.restart();
    h.launchVia(ws.dir);
    expect(h.table.curatorOf(ws.id)).toBeNull();

    // 兩者都沒有了：invalid。
    expect(unset(ws.id)).toEqual([
      { type: 'curatorRejected', code: 'invalid', reason: expect.any(String) },
    ]);
  });

  it('set-then-unset with a delayed writer leaves no binding on disk (one serialized, coalescing writer)', async () => {
    h.dispose();
    const gates: Array<() => void> = [];
    const written: string[] = [];
    h = new BindingHarness(async (file, data) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      written.push(data);
      await writeCuratorBindingsFile(file, data);
    });
    const alpha = h.workspace('alpha');
    const beta = h.workspace('beta');
    const a = h.launchVia(alpha.dir)!;
    const b = h.launchVia(beta.dir)!;

    set(alpha.id, a); // 第 1 次寫入開始（卡住）
    unset(alpha.id); // 排隊
    set(beta.id, b); // 併入同一次排隊
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()!();
    expect(await h.bindings.flush()).toBe(true);

    expect(written).toHaveLength(2);
    expect(h.fileBindings()).toEqual([{ workspaceId: beta.id, directoryPath: beta.dir }]);
    expect(gates).toHaveLength(0);
  });

  // ── 比對規則 ─────────────────────────────────────────────────

  it('roleId must match exactly (undefined only matches undefined)', async () => {
    const ws = h.workspace('alpha');
    h.bindings.set({ workspaceId: ws.id, directoryPath: ws.dir, roleId: 'writer.md' });
    h.launchVia(ws.dir);
    expect(h.table.curatorOf(ws.id)).toBeNull();

    const agent = { workspaceId: ws.id, directoryRealPath: ws.dir };
    const bound: CuratorBinding = { workspaceId: ws.id, directoryPath: ws.dir };
    expect(bindingMatchesAgent(bound, agent, ws.dir)).toBe(true);
    expect(bindingMatchesAgent({ ...bound, roleId: 'writer.md' }, agent, ws.dir)).toBe(false);
    expect(bindingMatchesAgent(bound, { ...agent, roleId: 'writer.md' }, ws.dir)).toBe(false);
    expect(
      bindingMatchesAgent(
        { ...bound, roleId: 'writer.md' },
        { ...agent, roleId: 'writer.md' },
        ws.dir,
      ),
    ).toBe(true);
    expect(
      bindingMatchesAgent(
        { ...bound, roleId: 'writer.md' },
        { ...agent, roleId: 'other.md' },
        ws.dir,
      ),
    ).toBe(false);
    expect(bindingMatchesAgent(bound, { ...agent, directoryRealPath: undefined }, ws.dir)).toBe(
      false,
    );
  });

  it('compares the agent and the binding case-insensitively on darwin, exactly on linux', () => {
    const ws = h.workspace('alpha');
    const agent = { workspaceId: ws.id, directoryRealPath: ws.dir };
    const upper: CuratorBinding = { workspaceId: ws.id, directoryPath: ws.dir.toUpperCase() };
    expect(upper.directoryPath).not.toBe(ws.dir);
    expect(
      bindingMatchesAgent(upper, agent, ws.dir, createPathNormalizer({ platform: 'darwin' })),
    ).toBe(true);
    expect(
      bindingMatchesAgent(upper, agent, ws.dir, createPathNormalizer({ platform: 'linux' })),
    ).toBe(false);
  });

  it('a Directory reassigned to another Workspace: the binding is pruned, and startAgent of the old record is not restored', async () => {
    const alpha = h.workspace('alpha');
    const beta = h.workspace('beta');
    h.sendB({ type: 'createAgent', directoryPath: alpha.dir });
    const recordId = h.store.nextAgentId.current - 1;
    expect(h.store.get(recordId)!.workspaceId).toBe(alpha.id);
    h.bindings.set({ workspaceId: alpha.id, directoryPath: alpha.dir });

    h.sendB({ type: 'saveWorkspace', id: alpha.id, name: 'alpha', directoryPaths: [] });
    expect(h.bindings.has(alpha.id)).toBe(false);
    h.sendB({
      type: 'saveWorkspace',
      id: beta.id,
      name: 'beta',
      directoryPaths: [beta.dir, alpha.dir],
    });

    // 即使綁定還在（例如舊版留下），改派之後的啟動也不恢復。
    h.bindings.set({ workspaceId: alpha.id, directoryPath: alpha.dir });
    const spawnedBefore = h.spawned.length;
    h.sendB({ type: 'startAgent', id: recordId });
    expect(h.spawned.length).toBe(spawnedBefore + 1);
    expect(h.table.curatorOf(alpha.id)).toBeNull();
    expect(h.table.curatorOf(beta.id)).toBeNull();
    expect(
      bindingMatchesAgent(
        { workspaceId: alpha.id, directoryPath: alpha.dir },
        { workspaceId: alpha.id, directoryRealPath: alpha.dir },
        alpha.dir,
      ),
    ).toBe(false);
  });

  it('removing the bound Directory from the Workspace (not-member) removes the binding and broadcasts', async () => {
    const ws = h.workspace('alpha');
    const other = path.join(h.tempHome, 'other');
    fs.mkdirSync(other);
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    expect(
      workspaceContainsDirectory(
        listWorkspaces().find((w) => w.id === ws.id)!,
        ws.dir,
      ),
    ).toBe('member');

    h.sendB({ type: 'saveWorkspace', id: ws.id, name: 'alpha', directoryPaths: [other] });
    expect(
      workspaceContainsDirectory(
        listWorkspaces().find((w) => w.id === ws.id)!,
        ws.dir,
      ),
    ).toBe('not-member');
    expect(h.bindings.has(ws.id)).toBe(false);
    expect(h.bindingBroadcasts().at(-1)).toEqual({
      type: 'curatorBindingChanged',
      workspaceId: ws.id,
      directoryPath: null,
    });
    await h.bindings.flush();
    expect(h.fileBindings()).toEqual([]);
  });

  it("an unresolvable directoryPaths entry makes membership 'unknown' and the binding is kept", async () => {
    const ws = h.workspace('alpha');
    const missing = path.join(h.tempHome, 'gone', 'repo');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    const broadcastsBefore = h.bindingBroadcasts().length;

    h.sendB({ type: 'saveWorkspace', id: ws.id, name: 'alpha', directoryPaths: [missing] });
    const saved = listWorkspaces().find((w) => w.id === ws.id)!;
    expect(saved.directoryPaths).toEqual([missing]);
    expect(workspaceContainsDirectory(saved, ws.dir)).toBe('unknown');
    expect(h.bindings.has(ws.id)).toBe(true);
    expect(h.bindingBroadcasts()).toHaveLength(broadcastsBefore);

    // 'unknown' 也不足以恢復。
    h.exitLast();
    await h.restart();
    h.launchVia(ws.dir);
    expect(h.table.curatorOf(ws.id)).toBeNull();
  });

  it('removing the Workspace removes its binding', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    h.sendB({ type: 'removeWorkspace', id: ws.id });
    expect(h.bindings.has(ws.id)).toBe(false);
    expect(h.bindingBroadcasts().at(-1)).toEqual({
      type: 'curatorBindingChanged',
      workspaceId: ws.id,
      directoryPath: null,
    });
    await h.bindings.flush();
    expect(h.fileBindings()).toEqual([]);
  });

  // ── 預設 Workspace ───────────────────────────────────────────

  it('the default Workspace never gets a binding and nothing is restored there', async () => {
    const a = h.launchVia(undefined)!;
    expect(h.store.get(a)!.workspaceId).toBeUndefined();
    expect(set(DEFAULT_WORKSPACE_ID, a)).toEqual([]);
    expect(h.table.curatorOf(DEFAULT_WORKSPACE_ID)).toBe(a);
    await h.bindings.flush();
    expect(h.bindings.list()).toEqual([]);
    expect(h.bindingBroadcasts()).toEqual([]);
    expect(fs.existsSync(curatorBindingsFilePath())).toBe(false);
    expect(
      h.bindings.set({ workspaceId: DEFAULT_WORKSPACE_ID, directoryPath: h.tempHome }),
    ).toBeNull();

    h.exitLast();
    await h.restart();
    h.launchVia(undefined);
    expect(h.table.curatorOf(DEFAULT_WORKSPACE_ID)).toBeNull();
    // 解除預設 Workspace：與以前相同（沒有 curator 就是 invalid）。
    expect(unset(DEFAULT_WORKSPACE_ID)).toEqual([
      { type: 'curatorRejected', code: 'invalid', reason: expect.any(String) },
    ]);
  });

  // ── 觸發點 ───────────────────────────────────────────────────

  it('only the four operator launch handlers call restoreFromBinding', async () => {
    const ws = h.workspace('alpha');
    const restore = vi.spyOn(h.table, 'restoreFromBinding');
    const calls = () => restore.mock.calls.length;

    // 1. launchAgent
    const launched = h.launchVia(ws.dir)!;
    expect(restore.mock.calls.at(-1)).toEqual([launched, ws.dir]);
    // 3. createAgent 帶 start
    h.sendB({ type: 'createAgent', directoryPath: ws.dir, start: true });
    const created = h.store.nextAgentId.current - 1;
    expect(restore.mock.calls.at(-1)).toEqual([created, ws.dir]);
    // 4. startAgent
    h.sendB({ type: 'createAgent', directoryPath: ws.dir });
    const record = h.store.nextAgentId.current - 1;
    expect(calls()).toBe(2); // 沒有 start：不呼叫
    h.sendB({ type: 'startAgent', id: record });
    expect(restore.mock.calls.at(-1)).toEqual([record, ws.dir]);
    // 2. Role 啟動
    const roles = path.join(ws.dir, '.claude', 'roles');
    fs.mkdirSync(roles, { recursive: true });
    fs.writeFileSync(path.join(roles, 'writer.md'), '# Writer\n');
    expect(saveUserDirectory({ name: 'alpha', path: ws.dir }).ok).toBe(true);
    const ask = async (msg: Record<string, unknown>, type: string) => {
      const replies = h.send(msg, h.ctxB());
      await vi.waitFor(() => expect(replies.some((m) => m.type === type)).toBe(true));
      return replies.find((m) => m.type === type)!;
    };
    const preview = await ask(
      { type: 'requestRolePreview', directoryPath: ws.dir, roleId: 'writer.md' },
      'rolePreview',
    );
    await ask(
      { type: 'confirmRole', directoryPath: ws.dir, roleId: 'writer.md', sha256: preview.sha256 },
      'roleConfirmed',
    );
    const spawnedBefore = h.spawned.length;
    h.sendB({ type: 'launchAgent', directoryPath: ws.dir, roleId: 'writer.md' });
    await vi.waitFor(() => expect(h.spawned.length).toBe(spawnedBefore + 1));
    const roleAgent = h.store.nextAgentId.current - 1;
    expect(h.store.get(roleAgent)!.roleId).toBe('writer.md');
    expect(restore.mock.calls.at(-1)).toEqual([roleAgent, ws.dir]);
    expect(calls()).toBe(4);

    // 其他訊息都不呼叫。
    h.sendB({ type: 'webviewReady' });
    h.sendB({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: launched });
    h.sendB({ type: 'unsetWorkspaceCurator', workspaceId: ws.id });
    h.sendB({ type: 'saveWorkspace', id: ws.id, name: 'alpha', directoryPaths: [ws.dir] });
    h.sendB({ type: 'closeAgent', id: launched });
    expect(calls()).toBe(4);
  });

  it('the source has exactly one restoreFromBinding call site, behind the four launch handlers', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(SERVER_SRC);
    const callers = files
      .filter((file) => /\.restoreFromBinding\(/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SERVER_SRC, file));
    expect(callers).toEqual(['clientMessageHandler.ts']);
    const handler = fs.readFileSync(path.join(SERVER_SRC, 'clientMessageHandler.ts'), 'utf-8');
    expect(handler.match(/\.restoreFromBinding\(/g)).toHaveLength(1);
    // 1 個定義 + 4 個呼叫（launchAgent、Role 啟動、createAgent 帶 start、startAgent）。
    expect(handler.match(/restoreCuratorAfterOperatorLaunch\(/g)).toHaveLength(5);
    // task dispatch 從不碰它。
    for (const file of files.filter((f) => f.includes(`${path.sep}taskDispatch${path.sep}`))) {
      expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/restoreFromBinding|curatorBindings/);
    }
  });

  it('agentAdded alone, a direct launchStandaloneAgent and a task-dispatch launch never restore', () => {
    const ws = h.workspace('alpha');
    h.bindings.set({ workspaceId: ws.id, directoryPath: ws.dir });
    const restore = vi.spyOn(h.table, 'restoreFromBinding');

    // store 事件：直接放入一個符合條件的 agent。
    const id = h.store.nextAgentId.current++;
    h.store.set(
      id,
      createAgentState({
        id,
        sessionId: 'session-direct',
        isExternal: false,
        projectDir: h.projectDir,
        jsonlFile: path.join(h.projectDir, 'session-direct.jsonl'),
        directoryName: 'alpha',
        providerId: 'claude',
        workspaceId: ws.id,
        directoryRealPath: ws.dir,
      }),
    );
    // launchStandaloneAgent 本身（含 task dispatch 的啟動設定）。
    const launched = launchStandaloneAgent(
      {
        store: h.store,
        runtime: h.runtime,
        ptyManager: h.manager,
        provider: { ...claudeProvider, getSessionDirs: () => [h.projectDir] },
        capabilities: h.capabilities,
        taskDispatch: {
          port: 43_210,
          shimPath: '/opt/pixel-agents/dist/hooks/pixel-agents-mcp.js',
        },
      },
      { directoryPath: ws.dir },
    );
    expect(launched).not.toBeNull();
    expect(h.store.get(launched!)!.directoryRealPath).toBe(ws.dir);
    expect(restore).not.toHaveBeenCalled();
    expect(h.table.curatorOf(ws.id)).toBeNull();
  });

  // ── 持久化失敗 ───────────────────────────────────────────────

  it('a failed save keeps the appointment in memory and tells the operator', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    h.failWrites = true;
    const replies = set(ws.id, a);
    expect(h.table.curatorOf(ws.id)).toBe(a);
    expect(await h.bindings.flush()).toBe(false);
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { type: 'workspaceRejected', reason: CURATOR_BINDING_SAVE_FAILED_REASON },
      ]),
    );
    expect(CURATOR_BINDING_SAVE_FAILED_REASON).toBe(
      '已指定 KB Writer，但無法儲存，重啟後不會自動恢復',
    );
    expect(h.table.curatorOf(ws.id)).toBe(a);
    expect(fs.existsSync(curatorBindingsFilePath())).toBe(false);
  });

  it('a failed removal still revokes and broadcasts first, then tells the operator', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    await h.bindings.flush();
    h.failWrites = true;
    const broadcastsBefore = h.broadcasts.length;
    const replies = unset(ws.id);
    // 同步：記憶體已清除、廣播已送出。
    expect(h.table.curatorOf(ws.id)).toBeNull();
    expect(h.bindings.has(ws.id)).toBe(false);
    expect(h.broadcasts.slice(broadcastsBefore).map((m) => m.type)).toEqual([
      'workspaceCuratorChanged',
      'curatorBindingChanged',
    ]);
    expect(replies).toEqual([]);
    expect(await h.bindings.flush()).toBe(false);
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { type: 'workspaceRejected', reason: CURATOR_BINDING_REMOVE_FAILED_REASON },
      ]),
    );
  });

  it('an appointment of an agent with no Directory realpath is reported as not saved', async () => {
    const ws = h.workspace('alpha');
    const a = h.launchVia(ws.dir)!;
    h.store.get(a)!.directoryRealPath = undefined;
    const replies = set(ws.id, a);
    expect(h.table.curatorOf(ws.id)).toBe(a);
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { type: 'workspaceRejected', reason: CURATOR_BINDING_SAVE_FAILED_REASON },
      ]),
    );
    expect(h.bindings.has(ws.id)).toBe(false);
  });

  // ── 稽核紀錄 ─────────────────────────────────────────────────

  it('the restore audit line carries ids only', async () => {
    const ws = h.workspace('secret-project');
    const a = h.launchVia(ws.dir)!;
    set(ws.id, a);
    h.exitLast();
    await h.restart();
    const restored = h.launchVia(ws.dir)!;
    expect(h.table.curatorOf(ws.id)).toBe(restored);

    const lines = vi
      .mocked(console.log)
      .mock.calls.map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('Curator'));
    const audit = lines.filter((line) => line.includes('restored as KB Writer'));
    expect(audit).toEqual([
      `[Pixel Agents] Curator: Agent ${restored} restored as KB Writer of Workspace ${ws.id} from its binding.`,
    ]);
    for (const line of lines) {
      expect(line).not.toContain(h.tempHome);
      expect(line).not.toContain('secret-project');
    }
  });

  // ── 讀檔失敗、偽造、過大 ─────────────────────────────────────

  describe('an untrustworthy file means no bindings, never a throw', () => {
    const writeRaw = (content: string, mode = 0o600) => {
      const file = curatorBindingsFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, content, { mode });
      fs.chmodSync(file, mode);
    };
    const valid = (ws: { id: string; dir: string }) =>
      JSON.stringify({ version: 1, bindings: [{ workspaceId: ws.id, directoryPath: ws.dir }] });

    /** 載入、啟動一個符合的 agent，確認沒有恢復，且 workspaces.json 照常運作。 */
    async function expectNoRestore(ws: { id: string; dir: string }): Promise<void> {
      await expect(h.restart()).resolves.toBeUndefined();
      expect(h.bindings.list()).toEqual([]);
      h.launchVia(ws.dir);
      expect(h.table.curatorOf(ws.id)).toBeNull();
      expect(listWorkspaces().some((w) => w.id === ws.id)).toBe(true);
      expect(saveWorkspace({ name: `again-${Math.random()}`, directoryPaths: [] }).ok).toBe(true);
    }

    it('the control: a valid private file restores', async () => {
      const ws = h.workspace('alpha');
      writeRaw(valid(ws));
      await h.restart();
      const a = h.launchVia(ws.dir)!;
      expect(h.table.curatorOf(ws.id)).toBe(a);
    });

    it('not JSON', async () => {
      const ws = h.workspace('alpha');
      writeRaw('{ not json');
      await expectNoRestore(ws);
    });

    it('wrong top-level shapes', async () => {
      const ws = h.workspace('alpha');
      const entry = { workspaceId: ws.id, directoryPath: ws.dir };
      for (const raw of [
        '[]',
        'null',
        JSON.stringify({ version: 2, bindings: [entry] }),
        JSON.stringify({ version: 1, bindings: {} }),
        JSON.stringify({ version: 1, bindings: [entry], extra: true }),
        JSON.stringify({
          version: 1,
          bindings: Array.from({ length: CURATOR_BINDINGS_MAX_ENTRIES + 1 }, () => entry),
        }),
      ]) {
        writeRaw(raw);
        await expectNoRestore(ws);
      }
    });

    it('oversized', async () => {
      const ws = h.workspace('alpha');
      writeRaw(
        JSON.stringify({
          version: 1,
          bindings: [{ workspaceId: ws.id, directoryPath: ws.dir }],
          pad: 'x'.repeat(CURATOR_BINDINGS_FILE_MAX_BYTES),
        }),
      );
      await expectNoRestore(ws);
    });

    it('forged: readable by others, or a symlink to a valid file', async () => {
      const ws = h.workspace('alpha');
      writeRaw(valid(ws), 0o644);
      await expectNoRestore(ws);

      const elsewhere = path.join(h.tempHome, 'planted.json');
      fs.writeFileSync(elsewhere, valid(ws), { mode: 0o600 });
      fs.rmSync(curatorBindingsFilePath(), { force: true });
      fs.symlinkSync(elsewhere, curatorBindingsFilePath());
      await expectNoRestore(ws);
    });

    it('drops invalid entries one by one and keeps the valid one', async () => {
      const ws = h.workspace('alpha');
      const dup = h.workspace('beta');
      writeRaw(
        JSON.stringify({
          version: 1,
          bindings: [
            { workspaceId: ws.id, directoryPath: ws.dir },
            { workspaceId: 'relative', directoryPath: 'not/absolute' },
            { workspaceId: 'nul', directoryPath: `${ws.dir}\u0000x` },
            { workspaceId: DEFAULT_WORKSPACE_ID, directoryPath: ws.dir },
            { workspaceId: 'x'.repeat(101), directoryPath: ws.dir },
            { workspaceId: 'badrole', directoryPath: ws.dir, roleId: '../evil.md' },
            { workspaceId: 'extra', directoryPath: ws.dir, agentId: 3 },
            { workspaceId: dup.id, directoryPath: dup.dir },
            { workspaceId: dup.id, directoryPath: ws.dir },
            'junk',
          ],
        }),
      );
      await h.restart();
      expect(h.bindings.list()).toEqual([{ workspaceId: ws.id, directoryPath: ws.dir }]);
      // 不存在的 Workspace 不在載入時刪除，使用時才檢查。
      writeRaw(
        JSON.stringify({
          version: 1,
          bindings: [{ workspaceId: 'no-such-workspace', directoryPath: ws.dir }],
        }),
      );
      await h.restart();
      expect(h.bindings.has('no-such-workspace')).toBe(true);
    });
  });
});
