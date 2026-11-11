/**
 * KB 唯讀瀏覽：listKbFiles／readKbFile 兩則訊息（只回給發問的連線，從不廣播）。
 *
 * 兩種 KB 根目錄，每次請求都重新推導、不快取：
 * - 個人 KB：`<agent.directoryRealPath>/.note/<personalKbKey(agent.roleId)>`。
 *   Agent 必須存在且有 directoryRealPath（絕不退回 launchDirectory、cwd 或
 *   directoryName），識別鍵為 null 即拒絕（絕不退回保留鍵）。
 * - 工作空間 KB：當下 listWorkspaces() 的 rootPath，realpath 後加上 `.note`。
 * 可信基底之後只接字面的 `.note` 與字面的識別鍵；每一層都以 lstat 確認是真正的目錄
 * （symlink 即 unsafe），從不建立目錄。
 *
 * 讀取：relPath 逐段在執行期重新驗證（線上 schema 不會被強制）；中間每一段 lstat
 * 必須是真正的目錄；最後一段以 O_NOFOLLOW|O_NONBLOCK 開啟（kbFiles.readBoundedFile），
 * fstat 必須是一般檔案且 nlink 為 1、大小受限；讀完再以 dev／ino 重查整條目錄鏈，
 * 最後以 decodeSafeText 嚴格解碼。
 *
 * 列舉：opendir 有界掃描（深度、總項目、每目錄項目、回傳檔案數皆有上限，碰到即
 * truncated），每個項目都 lstat（不信任 Dirent 型別），略過 symlink、非一般檔案、
 * 硬連結、`.` 開頭、不在允許清單的副檔名、含控制或不可見字元的名稱，以及只差在
 * 大小寫的名稱（兩者都略過）。列舉時不開啟任何檔案。
 *
 * 整個處理包在錯誤邊界內：不會有未處理的 rejection，也不會從 handleClientMessage
 * 丟出例外。記錄只帶 errno 代碼與 id，絕不帶 relPath、err.message 或主機路徑；
 * 回覆只帶固定的理由代碼。
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  AgentKbTarget,
  KbFileEntry,
  KbRejectionReason,
  WorkspaceKbTarget,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  KB_BROWSE_ALLOWED_EXTENSIONS,
  KB_BROWSE_DIR_MAX_ENTRIES,
  KB_BROWSE_FILE_MAX_BYTES,
  KB_BROWSE_LIST_MAX_FILES,
  KB_BROWSE_MAX_DEPTH,
  KB_BROWSE_MAX_IN_FLIGHT,
  KB_BROWSE_REL_PATH_MAX_LENGTH,
  KB_BROWSE_SCAN_MAX_ENTRIES,
  KB_BROWSE_SEGMENT_MAX_BYTES,
  WORKSPACE_ID_MAX_LENGTH,
} from './constants.js';
import { assertKbPlatform, errnoCode, kbLog, readBoundedFile } from './kbFiles.js';
import { sameInode } from './roles.js';
import { decodeSafeText, hasInvisibleCharacter, isForbiddenCodePoint } from './textSafety.js';
import { listWorkspaces } from './workspaces.js';
import { personalKbKey, personalKbOwnRoot, personalKbZone } from './writeGuard/kbIdentity.js';
import { pathNormalizer } from './writeGuard/pathNormalization.js';

export type KbTarget = AgentKbTarget | WorkspaceKbTarget;

type Reply = (message: Record<string, unknown>) => void;

/** 一個連線的 KB 瀏覽額度：同時處理中的請求數（每個連線各一份）。 */
export interface KbBrowseSlots {
  inFlight: number;
}

export function createKbBrowseSlots(): KbBrowseSlots {
  return { inFlight: 0 };
}

export interface KbBrowseDeps {
  reply: Reply;
  store: AgentStateStore;
  /** 這個連線的額度；缺少時一律以 unavailable 拒絕（fail-closed）。 */
  slots: KbBrowseSlots | undefined;
}

/** 在處理中丟出，回覆 kbRejected 並停止。 */
class KbBrowseRefusal extends Error {
  constructor(readonly reason: KbRejectionReason) {
    super(reason);
  }
}

function refuse(reason: KbRejectionReason): never {
  throw new KbBrowseRefusal(reason);
}

// ── 輸入驗證 ────────────────────────────────────────────────

/** C0／C1 控制字元（含 tab、換行、CR：檔名中不允許）。 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
/** 解碼失敗的位元組會變成 U+FFFD：這種名稱讀不回同一個檔案。 */
const REPLACEMENT_CHARACTER = '�';
/** 只用於記錄：看起來像 id 的工作空間 id 才寫進記錄。 */
const LOGGABLE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** target 的執行期驗證：只接受兩種形狀之一、不接受多餘欄位；回傳重新建立的物件
 *  （回覆中回傳的是這個，絕不是用戶端送來的原物件）。 */
export function parseKbTarget(value: unknown): KbTarget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2) return null;
  if (record.scope === 'agent') {
    const { agentId } = record;
    if (typeof agentId !== 'number' || !Number.isSafeInteger(agentId)) return null;
    return { scope: 'agent', agentId };
  }
  if (record.scope === 'workspace') {
    const { workspaceId } = record;
    if (
      typeof workspaceId !== 'string' ||
      workspaceId.length === 0 ||
      workspaceId.length > WORKSPACE_ID_MAX_LENGTH ||
      workspaceId.includes('\0')
    ) {
      return null;
    }
    return { scope: 'workspace', workspaceId };
  }
  return null;
}

/** 一個可瀏覽的路徑段（列舉與讀取共用同一條規則，列出來的名稱才讀得回去）。 */
export function isBrowsableName(name: string): boolean {
  if (name.length === 0 || name.startsWith('.')) return false; // 含 `.`、`..`、隱藏檔
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (Buffer.byteLength(name, 'utf8') > KB_BROWSE_SEGMENT_MAX_BYTES) return false;
  if (CONTROL_CHARACTER.test(name) || name.includes(REPLACEMENT_CHARACTER)) return false;
  if (hasInvisibleCharacter(name)) return false; // 含方向標記、零寬字元、孤立代理對
  for (const char of name) {
    if (isForbiddenCodePoint(char.codePointAt(0) as number)) return false; // 方向覆寫、tag、BOM
  }
  return true;
}

/** 副檔名允許清單（小寫、完全比對）。 */
export function hasAllowedExtension(name: string): boolean {
  return KB_BROWSE_ALLOWED_EXTENSIONS.includes(path.posix.extname(name));
}

/**
 * relPath 的執行期驗證：字串、長度上限、只以 `/` 切段、沒有空段／`.`／`..`／
 * `.` 開頭的段、沒有 NUL 或反斜線、不是 posix 或 win32 的絕對路徑、段數上限。
 * 回傳各段，不合格回 null。
 */
export function parseKbRelPath(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > KB_BROWSE_REL_PATH_MAX_LENGTH) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const segments = value.split('/');
  if (segments.length > KB_BROWSE_MAX_DEPTH) return null;
  return segments.every(isBrowsableName) ? segments : null;
}

/** 只在 POSIX 且有 O_NOFOLLOW／O_NONBLOCK 時提供（同 Roles 與 KB 儲存的限制）。 */
function browsePlatformSupported(): boolean {
  try {
    assertKbPlatform();
  } catch {
    return false;
  }
  return fs.constants.O_NOFOLLOW !== undefined && fs.constants.O_NONBLOCK !== undefined;
}

// ── 目錄鏈 ──────────────────────────────────────────────────

interface DirectoryLevel {
  dir: string;
  stats: fs.Stats;
}

interface KbRoot {
  /** KB 根目錄（目錄鏈的最後一層）。 */
  root: string;
  /** 從可信基底到 KB 根的每一層，讀取或列舉之後逐層以 dev／ino 重查。 */
  chain: DirectoryLevel[];
  /** 記錄用的 id（絕不含路徑）。 */
  ids: string[];
}

/** lstat 一層：真正的目錄回 Stats；不存在回 absent；其他（symlink、檔案等）回 unsafe。
 *  以 roles.ts 的 lstatRealDirectory 為範本，但區分「不存在」與「不安全」。 */
async function lstatLevel(dir: string): Promise<fs.Stats | 'absent' | 'unsafe'> {
  try {
    const stats = await fs.promises.lstat(dir);
    return stats.isDirectory() && !stats.isSymbolicLink() ? stats : 'unsafe';
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    throw err;
  }
}

async function requireLevel(dir: string): Promise<DirectoryLevel> {
  const stats = await lstatLevel(dir);
  if (stats === 'absent') refuse('not_found');
  if (stats === 'unsafe') refuse('unsafe');
  return { dir, stats };
}

/** 每一層都必須仍是當初檢查過的那個目錄：中途被換掉（例如換成 symlink）即 unsafe。 */
async function recheckLevels(levels: DirectoryLevel[]): Promise<void> {
  for (const level of levels) {
    const now = await lstatLevel(level.dir);
    if (typeof now === 'string' || !sameInode(now, level.stats)) refuse('unsafe');
  }
}

async function resolveAgentRoot(target: AgentKbTarget, store: AgentStateStore): Promise<KbRoot> {
  const agent = store.get(target.agentId);
  if (!agent) refuse('not_found');
  // 只認啟動時記錄的 Directory realpath；沒有就不提供，絕不改用其他欄位。
  const base = agent.directoryRealPath;
  if (typeof base !== 'string' || !path.isAbsolute(base)) refuse('unavailable');
  const key = personalKbKey(agent.roleId);
  if (key === null) refuse('unavailable');
  const baseLevel = await requireLevel(base);
  const noteLevel = await requireLevel(personalKbZone(base));
  const ownLevel = await requireLevel(personalKbOwnRoot(base, key));
  return {
    root: ownLevel.dir,
    chain: [baseLevel, noteLevel, ownLevel],
    ids: ['agent', String(target.agentId)],
  };
}

async function resolveWorkspaceRoot(target: WorkspaceKbTarget): Promise<KbRoot> {
  // 每次都重新讀取清單，不快取。
  const workspace = listWorkspaces().find((w) => w.id === target.workspaceId);
  if (!workspace) refuse('not_found');
  if (workspace.rootPath === undefined) refuse('unavailable');
  const ids = LOGGABLE_ID.test(workspace.id) ? ['workspace', workspace.id] : ['workspace'];
  let base: string;
  try {
    base = await fs.promises.realpath(workspace.rootPath);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') refuse('not_found');
    throw err;
  }
  const baseLevel = await requireLevel(base);
  const noteLevel = await requireLevel(personalKbZone(base));
  return { root: noteLevel.dir, chain: [baseLevel, noteLevel], ids };
}

function resolveRoot(target: KbTarget, store: AgentStateStore): Promise<KbRoot> {
  return target.scope === 'agent' ? resolveAgentRoot(target, store) : resolveWorkspaceRoot(target);
}

// ── 讀取 ────────────────────────────────────────────────────

async function readKbText(kbRoot: KbRoot, segments: string[]): Promise<string> {
  const fileName = segments[segments.length - 1];
  if (!hasAllowedExtension(fileName)) refuse('not_text');
  const filePath = path.join(kbRoot.root, ...segments);
  // 以路徑邊界判斷（不是 startsWith）：`a.md` 不會被當成在 `a.md.md` 之內，反之亦然。
  if (filePath === kbRoot.root || !pathNormalizer.isWithin(filePath, kbRoot.root)) {
    refuse('unsafe');
  }

  const levels: DirectoryLevel[] = [];
  let dir = kbRoot.root;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    levels.push(await requireLevel(dir));
  }

  const read = await readBoundedFile(filePath, KB_BROWSE_FILE_MAX_BYTES);
  if (read.state === 'absent') refuse('not_found');
  if (read.state === 'not_regular') refuse('unsafe'); // symlink、FIFO、裝置、目錄
  if (read.state === 'too_large') refuse('too_large');
  if (read.state === 'error') {
    if (read.errno === 'ENOTDIR') refuse('not_found');
    throw Object.assign(new Error('read failed'), { code: read.errno });
  }
  // 硬連結：同一份內容也存在於 KB 之外的某處，不提供。
  if (read.stats.nlink !== 1) refuse('unsafe');
  await recheckLevels([...kbRoot.chain, ...levels]);

  const text = decodeSafeText(read.bytes);
  if (text === null) refuse('not_text');
  return text;
}

// ── 列舉 ────────────────────────────────────────────────────

interface ScanState {
  files: KbFileEntry[];
  scanned: number;
  truncated: boolean;
}

interface ScannedEntry {
  name: string;
  stats: fs.Stats;
}

function caseKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** 讀一個目錄的項目（有界），每個合格名稱都 lstat；不開啟任何檔案。 */
async function readEntries(dir: string, state: ScanState): Promise<ScannedEntry[]> {
  const entries: ScannedEntry[] = [];
  const handle = await fs.promises.opendir(dir);
  try {
    for (let seenHere = 0; ; seenHere++) {
      if (seenHere >= KB_BROWSE_DIR_MAX_ENTRIES || state.scanned >= KB_BROWSE_SCAN_MAX_ENTRIES) {
        if ((await handle.read()) !== null) state.truncated = true;
        break;
      }
      const dirent = await handle.read();
      if (!dirent) break;
      state.scanned++;
      if (!isBrowsableName(dirent.name)) continue;
      try {
        entries.push({
          name: dirent.name,
          stats: await fs.promises.lstat(path.join(dir, dirent.name)),
        });
      } catch {
        // 在 readdir 與 lstat 之間消失：不列出。
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  // 只差在大小寫的名稱兩者都略過（不分大小寫的磁碟上它們不可靠地是兩個項目）。
  const caseCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = caseKey(entry.name);
    caseCounts.set(key, (caseCounts.get(key) ?? 0) + 1);
  }
  return entries
    .filter((entry) => caseCounts.get(caseKey(entry.name)) === 1)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function scanDirectory(dir: string, prefix: string[], state: ScanState): Promise<void> {
  const entries = await readEntries(dir, state);
  const subdirectories: ScannedEntry[] = [];
  for (const entry of entries) {
    if (entry.stats.isSymbolicLink()) continue;
    if (entry.stats.isDirectory()) {
      subdirectories.push(entry);
      continue;
    }
    if (!entry.stats.isFile() || entry.stats.nlink !== 1 || !hasAllowedExtension(entry.name)) {
      continue;
    }
    if (state.files.length >= KB_BROWSE_LIST_MAX_FILES) {
      state.truncated = true;
      return;
    }
    state.files.push({ path: [...prefix, entry.name].join('/'), size: entry.stats.size });
  }

  for (const sub of subdirectories) {
    // 子目錄內的檔案會有 prefix.length + 2 段，超過深度上限就不往下走。
    if (prefix.length + 2 > KB_BROWSE_MAX_DEPTH) {
      state.truncated = true;
      continue;
    }
    const subDir = path.join(dir, sub.name);
    const level: DirectoryLevel = { dir: subDir, stats: sub.stats };
    const mark = state.files.length;
    try {
      await recheckLevels([level]);
      await scanDirectory(subDir, [...prefix, sub.name], state);
      // opendir 會跟隨 symlink：掃完再確認仍是同一個目錄，否則撤回這段的結果。
      await recheckLevels([level]);
    } catch (err) {
      state.files.length = mark;
      if (!(err instanceof KbBrowseRefusal)) state.truncated = true; // 讀不了的子目錄
    }
    if (state.files.length >= KB_BROWSE_LIST_MAX_FILES && state.truncated) return;
  }
}

async function listKbEntries(
  kbRoot: KbRoot,
): Promise<{ files: KbFileEntry[]; truncated: boolean }> {
  const state: ScanState = { files: [], scanned: 0, truncated: false };
  await scanDirectory(kbRoot.root, [], state);
  await recheckLevels(kbRoot.chain);
  const files = [...state.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, truncated: state.truncated };
}

// ── 訊息處理 ────────────────────────────────────────────────

function rejectedMessage(
  target: KbTarget | null,
  relPath: string | undefined,
  reason: KbRejectionReason,
): Record<string, unknown> {
  return {
    type: 'kbRejected',
    ...(target ? { target } : {}),
    ...(relPath !== undefined ? { relPath } : {}),
    reason,
  };
}

function safeReply(deps: KbBrowseDeps, message: Record<string, unknown>): void {
  try {
    deps.reply(message);
  } catch {
    // 連線已關閉：沒有人可以回覆。
  }
}

async function handleList(target: KbTarget, deps: KbBrowseDeps): Promise<Record<string, unknown>> {
  const kbRoot = await resolveRoot(target, deps.store);
  const { files, truncated } = await listKbEntries(kbRoot);
  return { type: 'kbFilesListed', target, files, truncated };
}

async function handleRead(
  target: KbTarget,
  segments: string[],
  deps: KbBrowseDeps,
): Promise<Record<string, unknown>> {
  const kbRoot = await resolveRoot(target, deps.store);
  const content = await readKbText(kbRoot, segments);
  // 內容只回給發問者，且絕不寫進記錄。
  return { type: 'kbFileRead', target, relPath: segments.join('/'), content };
}

function logIds(target: KbTarget | null): string[] {
  if (!target) return [];
  if (target.scope === 'agent') return ['agent', String(target.agentId)];
  return LOGGABLE_ID.test(target.workspaceId) ? ['workspace', target.workspaceId] : ['workspace'];
}

async function run(msg: Record<string, unknown>, deps: KbBrowseDeps): Promise<void> {
  const isRead = msg.type === 'readKbFile';
  const target = parseKbTarget(msg.target);
  // 回傳 relPath 只為了讓用戶端配對回覆；只回傳長度在上限內的字串。
  const echoRelPath =
    isRead && typeof msg.relPath === 'string' && msg.relPath.length <= KB_BROWSE_REL_PATH_MAX_LENGTH
      ? msg.relPath
      : undefined;

  const slots = deps.slots;
  if (!slots || slots.inFlight >= KB_BROWSE_MAX_IN_FLIGHT) {
    safeReply(deps, rejectedMessage(target, echoRelPath, 'unavailable'));
    return;
  }
  slots.inFlight++;
  try {
    if (!target) refuse('not_found');
    const segments = isRead ? parseKbRelPath(msg.relPath) : null;
    if (isRead && !segments) refuse('unsafe');
    if (!browsePlatformSupported()) refuse('unavailable');
    const reply = segments
      ? await handleRead(target, segments, deps)
      : await handleList(target, deps);
    safeReply(deps, reply);
  } catch (err) {
    if (err instanceof KbBrowseRefusal) {
      safeReply(deps, rejectedMessage(target, echoRelPath, err.reason));
      return;
    }
    // errno 代碼與 id 而已：err.message 會帶著解析過的路徑。
    kbLog(`browse ${isRead ? 'read' : 'list'} failed`, {
      errno: errnoCode(err),
      ids: logIds(target),
    });
    safeReply(deps, rejectedMessage(target, echoRelPath, 'unavailable'));
  } finally {
    slots.inFlight--;
  }
}

/**
 * 分派一則 KB 瀏覽訊息。不是 listKbFiles／readKbFile 就回 false。回傳的 promise
 * 供測試等待；呼叫端可以不等（它永不 reject）。
 */
export function handleKbBrowseMessage(
  msg: Record<string, unknown>,
  deps: KbBrowseDeps,
): Promise<void> | false {
  if (msg.type !== 'listKbFiles' && msg.type !== 'readKbFile') return false;
  return run(msg, deps).catch(() => undefined);
}
