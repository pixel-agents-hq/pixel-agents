/**
 * KB Writer 綁定：伺服器重啟後自動恢復 Workspace 的 KB Writer（curator）。
 *
 * 重啟後 PTY agent 不會被恢復（agentRuntime 只恢復外部 agent），agent id 因此無法
 * 被記住；綁定改記 (workspaceId, Directory 的 realpath, roleId)。之後由操作者在這個
 * Directory 啟動的 agent（四個 /ws 啟動處理器，見 clientMessageHandler.ts）若完全
 * 符合 bindingMatchesAgent，就經由 CuratorTable.appoint 重新指定。curator 同時握有
 * KB 寫入與 dispatch_task 權限，所以自動恢復等同授權：比對規則全部成立才恢復。
 *
 * 儲存：~/.pixel-agents/curator-bindings.json（0600，writeFileSecure：不可預測的
 * tmp 名稱、rename 覆蓋）。不放 workspaces.json，也不在線上 Workspace schema 裡。
 * 記憶體中的表是唯一權威；只有一個序列化的寫入者，每次寫最新的完整快照（合併中間
 * 的變更），所以先設定、後解除的兩次變更不可能在磁碟上顛倒順序。
 *
 * 讀取：讀檔、JSON、整體結構任何一項失敗 => 沒有任何綁定（不自動恢復），只記錄
 * errno 或狀態，啟動時絕不丟例外。逐筆驗證，不合格的那筆丟棄。Workspace 是否存在
 * 在使用時檢查，不在讀取時刪除。
 *
 * 預設 Workspace 永遠不寫綁定（它沒有明確的 directoryPaths，workspaceIdForDirectory
 * 也從不回傳它）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { workspaceKey } from './capabilities.js';
import {
  CURATOR_BINDINGS_FILE_MAX_BYTES,
  CURATOR_BINDINGS_FILE_NAME,
  CURATOR_BINDINGS_FILE_VERSION,
  CURATOR_BINDINGS_MAX_ENTRIES,
  LAYOUT_FILE_DIR,
  WORKSPACE_DIRECTORY_PATH_MAX_LENGTH,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACES_DIR_MODE,
} from './constants.js';
import { parseJsonStrict, readBoundedFile } from './kbFiles.js';
import { errnoCode, isPrivateFile } from './privateStorage.js';
import { isValidRoleId } from './roles.js';
import { writeFileSecure } from './secureFileWrite.js';
import type { AgentState } from './types.js';
import {
  listWorkspaces,
  workspaceContainsDirectory,
  workspaceIdForDirectory,
} from './workspaces.js';
import { type PathNormalizer, pathNormalizer, samePath } from './writeGuard/pathNormalization.js';

/** 一筆綁定。roleId 只存在伺服器端，不上線。 */
export interface CuratorBinding {
  workspaceId: string;
  /** 指定當下 agent 的 Directory realpath。 */
  directoryPath: string;
  roleId?: string;
}

/** 寫入完整快照；失敗時丟例外。可替換（測試用延遲或失敗的寫入者）。 */
export type CuratorBindingWriter = (filePath: string, data: string) => Promise<void>;

export interface CuratorBindingStoreOptions {
  /** 預設 ~/.pixel-agents/curator-bindings.json（建構時解析 $HOME）。 */
  filePath?: string;
  write?: CuratorBindingWriter;
  /** 每次綁定改變都廣播 curatorBindingChanged（設定、解除、移除）。 */
  broadcast?: (message: Record<string, unknown>) => void;
}

const ENTRY_KEYS = new Set(['workspaceId', 'directoryPath', 'roleId']);
const FILE_KEYS = ['bindings', 'version'];

export function curatorBindingsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CURATOR_BINDINGS_FILE_NAME);
}

/** 預設的寫入者：確保 ~/.pixel-agents 存在，再以 writeFileSecure 原子覆寫（0600）。 */
export async function writeCuratorBindingsFile(filePath: string, data: string): Promise<void> {
  // 共用的 ~/.pixel-agents：已存在的沿用它的權限。
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: WORKSPACES_DIR_MODE });
  await writeFileSecure(filePath, data);
}

/** 一筆綁定的欄位驗證（讀檔與寫入共用）；不合格回 null。 */
function validBinding(workspaceId: unknown, directoryPath: unknown, roleId: unknown) {
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    workspaceId.length > WORKSPACE_ID_MAX_LENGTH ||
    workspaceId.includes('\0') ||
    workspaceId === DEFAULT_WORKSPACE_ID
  ) {
    return null;
  }
  if (
    typeof directoryPath !== 'string' ||
    directoryPath.length === 0 ||
    directoryPath.length > WORKSPACE_DIRECTORY_PATH_MAX_LENGTH ||
    directoryPath.includes('\0') ||
    !path.isAbsolute(directoryPath)
  ) {
    return null;
  }
  if (roleId !== undefined && !isValidRoleId(roleId)) return null;
  const binding: CuratorBinding = { workspaceId, directoryPath };
  if (roleId !== undefined) binding.roleId = roleId;
  return binding;
}

function parseBindingEntry(item: unknown): CuratorBinding | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const entry = item as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return null;
  return validBinding(entry.workspaceId, entry.directoryPath, entry.roleId);
}

/**
 * 檔案內容 -> 綁定清單；整體結構不對回 null（整份不採信）。
 * 逐筆驗證：不合格的丟棄；同一個 workspaceId 出現多次時全部丟棄（無法判斷哪筆才對）。
 */
export function parseCuratorBindingsFile(raw: unknown): {
  bindings: CuratorBinding[];
  dropped: number;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== FILE_KEYS.length || keys.some((key, i) => key !== FILE_KEYS[i])) return null;
  if (record.version !== CURATOR_BINDINGS_FILE_VERSION || !Array.isArray(record.bindings)) {
    return null;
  }
  if (record.bindings.length > CURATOR_BINDINGS_MAX_ENTRIES) return null;
  const parsed = record.bindings
    .map(parseBindingEntry)
    .filter((b): b is CuratorBinding => b !== null);
  const counts = new Map<string, number>();
  for (const binding of parsed) {
    counts.set(binding.workspaceId, (counts.get(binding.workspaceId) ?? 0) + 1);
  }
  const bindings = parsed.filter((binding) => counts.get(binding.workspaceId) === 1);
  return { bindings, dropped: record.bindings.length - bindings.length };
}

/**
 * 自動恢復的比對規則，全部成立才算符合：
 * - agent 有 directoryRealPath，且與綁定的路徑 samePath（darwin／win32 折疊大小寫）；
 * - roleId 相同（undefined 只符合 undefined）；
 * - agent 歸屬的 Workspace 就是綁定的 Workspace；
 * - 這次啟動的 Directory 目前歸屬的 Workspace 也是它（Directory 改派之後不恢復）；
 * - 該 Workspace 存在，且 workspaceContainsDirectory(…, agent 的 realpath) === 'member'。
 * 「名額空著」由呼叫端（CuratorTable）檢查。
 */
export function bindingMatchesAgent(
  binding: CuratorBinding,
  agent: Pick<AgentState, 'workspaceId' | 'directoryRealPath' | 'roleId'>,
  launchDirectory: string | undefined,
  normalizer: PathNormalizer = pathNormalizer,
): boolean {
  const realDirectory = agent.directoryRealPath;
  if (realDirectory === undefined) return false;
  if (!samePath(normalizer, realDirectory, binding.directoryPath)) return false;
  if (agent.roleId !== binding.roleId) return false;
  if (workspaceKey(agent.workspaceId) !== binding.workspaceId) return false;
  if (workspaceKey(workspaceIdForDirectory(launchDirectory)) !== binding.workspaceId) return false;
  const workspace = listWorkspaces().find((w) => w.id === binding.workspaceId);
  if (!workspace) return false;
  return workspaceContainsDirectory(workspace, realDirectory, normalizer) === 'member';
}

interface PendingWrite {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}

export class CuratorBindingStore {
  /** workspaceId -> 綁定（記憶體中的權威表）。 */
  private readonly bindings = new Map<string, CuratorBinding>();
  private readonly filePath: string;
  private readonly write: CuratorBindingWriter;
  private readonly broadcast: (message: Record<string, unknown>) => void;
  private writing = false;
  /** 正在進行的那次寫入（flush 等它）。 */
  private inFlight: Promise<boolean> | null = null;
  /** 下一次寫入：在它開始前發生的所有變更共用這一次（寫的是當下最新的快照）。 */
  private queued: PendingWrite | null = null;

  constructor(options: CuratorBindingStoreOptions = {}) {
    this.filePath = options.filePath ?? curatorBindingsFilePath();
    this.write = options.write ?? writeCuratorBindingsFile;
    this.broadcast = options.broadcast ?? (() => undefined);
  }

  /** 從磁碟載入，取代記憶體內容。任何失敗都只是「沒有綁定」，絕不丟例外。 */
  async load(): Promise<void> {
    this.bindings.clear();
    try {
      const read = await readBoundedFile(this.filePath, CURATOR_BINDINGS_FILE_MAX_BYTES);
      if (read.state === 'absent') return;
      if (read.state !== 'ok') {
        const detail = read.state === 'error' ? read.errno : read.state;
        console.error(
          `[Pixel Agents] Curator bindings: file not loaded (${detail}); no KB Writer will be restored.`,
        );
        return;
      }
      if (!isPrivateFile(read.stats)) {
        console.error(
          '[Pixel Agents] Curator bindings: file is not private to the operator; no KB Writer will be restored.',
        );
        return;
      }
      const parsed = parseCuratorBindingsFile(parseJsonStrict(read.bytes));
      if (!parsed) {
        console.error(
          '[Pixel Agents] Curator bindings: file has an unexpected structure; no KB Writer will be restored.',
        );
        return;
      }
      for (const binding of parsed.bindings) this.bindings.set(binding.workspaceId, binding);
      if (parsed.dropped > 0) {
        console.warn(`[Pixel Agents] Curator bindings: dropped ${parsed.dropped} invalid entries.`);
      }
    } catch (err) {
      this.bindings.clear();
      console.error(`[Pixel Agents] Curator bindings: load failed (${errnoCode(err)}).`);
    }
  }

  get(workspaceId: string | undefined): CuratorBinding | undefined {
    const binding = this.bindings.get(workspaceKey(workspaceId));
    return binding === undefined ? undefined : { ...binding };
  }

  has(workspaceId: string | undefined): boolean {
    return this.bindings.has(workspaceKey(workspaceId));
  }

  list(): CuratorBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  /** curatorsLoaded 的 bindings：不含 roleId。 */
  wireList(): Array<{ workspaceId: string; directoryPath: string }> {
    return [...this.bindings.values()].map(({ workspaceId, directoryPath }) => ({
      workspaceId,
      directoryPath,
    }));
  }

  /**
   * 設定（或取代）一個 Workspace 的綁定：記憶體與廣播立即生效，回傳磁碟寫入的結果。
   * 欄位不合格（含預設 Workspace）時什麼都不改，回 null。
   */
  set(input: CuratorBinding): Promise<boolean> | null {
    const binding = validBinding(input.workspaceId, input.directoryPath, input.roleId);
    if (!binding) return null;
    this.bindings.set(binding.workspaceId, binding);
    console.log(`[Pixel Agents] Curator bindings: bound Workspace ${binding.workspaceId}.`);
    this.broadcast({
      type: 'curatorBindingChanged',
      workspaceId: binding.workspaceId,
      directoryPath: binding.directoryPath,
    });
    return this.persist();
  }

  /**
   * 移除一個 Workspace 的綁定：記憶體與廣播先行（撤銷不等磁碟），回傳磁碟寫入的結果。
   * 沒有綁定時什麼都不做，回 null。
   */
  remove(workspaceId: string | undefined): Promise<boolean> | null {
    const key = workspaceKey(workspaceId);
    if (!this.bindings.delete(key)) return null;
    console.log(`[Pixel Agents] Curator bindings: unbound Workspace ${key}.`);
    this.broadcast({ type: 'curatorBindingChanged', workspaceId: key, directoryPath: null });
    return this.persist();
  }

  /**
   * saveWorkspace 之後：綁定的 Directory 確定已不屬於該 Workspace（'not-member'）
   * 才移除；'unknown'（有項目無法解析）與 'member' 都保留。Workspace 不存在時不在這裡
   * 處理（removeWorkspace 自己移除；使用時也會檢查）。
   */
  pruneIfNotMember(workspaceId: string): Promise<boolean> | null {
    const binding = this.bindings.get(workspaceKey(workspaceId));
    if (!binding) return null;
    const workspace = listWorkspaces().find((w) => w.id === binding.workspaceId);
    if (!workspace) return null;
    if (workspaceContainsDirectory(workspace, binding.directoryPath) !== 'not-member') return null;
    return this.remove(binding.workspaceId);
  }

  /** 等目前已排定的寫入完成；沒有排定時立即回 true。 */
  flush(): Promise<boolean> {
    return this.queued?.promise ?? this.inFlight ?? Promise.resolve(true);
  }

  private serialize(): string {
    const bindings = [...this.bindings.values()].map((binding) => ({ ...binding }));
    return `${JSON.stringify({ version: CURATOR_BINDINGS_FILE_VERSION, bindings }, null, 2)}\n`;
  }

  private persist(): Promise<boolean> {
    if (this.queued) return this.queued.promise;
    let resolve: (ok: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.queued = { promise, resolve };
    // drain 同步地取走 queued 並開始寫入，所以先留住 promise。
    if (!this.writing) void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    this.writing = true;
    try {
      while (this.queued) {
        const waiter = this.queued;
        this.queued = null;
        this.inFlight = waiter.promise;
        // 快照在寫入開始時才取，所以它包含排隊期間的每一次變更。
        const data = this.serialize();
        let ok = true;
        try {
          await this.write(this.filePath, data);
        } catch (err) {
          ok = false;
          console.error(`[Pixel Agents] Curator bindings: write failed (${errnoCode(err)}).`);
        }
        waiter.resolve(ok);
      }
    } finally {
      this.writing = false;
      this.inFlight = null;
    }
  }
}
