/**
 * 路徑正規化（P1 定義介面，P2 替換實作；claude-hook.ts 不需要再修改）。
 *
 * 同一份實作同時用在兩端，兩端才能比對得起來：
 * - hook 端：把工具欄位裡的路徑（可能是相對路徑、可能尚未存在）轉成解過 symlink 的絕對路徑；
 * - 伺服器端：計算受保護區（KB 區、F17 拒絕清單）的根目錄（重算清單時做，不在裁決時做，F13）。
 *
 * P2 的語意（F8）：
 * - 以作業系統語意逐段解析：遇到 symlink 先把它的目標接進來，再處理後面的 `..`
 *   （`a/link/../b` 是「link 目標的上層」/b，不是字面的 a/b）；
 * - 尚不存在的部分照字面接回（新檔案也能比對）；最後一段是懸空 symlink 時，
 *   以它的目標為準（寫入會建立目標檔）；
 * - darwin、win32 的比對一律折疊大小寫（darwin 另做 NFC），因為兩者的預設檔案系統
 *   不分大小寫：`.NOTE/a.md` 就是 `.note/a.md`；
 * - 相對路徑搭配空的或相對的 cwd：回 null，由呼叫端當成「無法判斷」fail-closed。
 *
 * hook 端另外以 normalizeTargetCandidates 加上「先以字面消去 `..` 再解析」的候選，
 * 因為寫入工具本身可能用字面語意（path.resolve）；兩個候選任一命中受保護區即命中。
 *
 * 假設（未實測，P0 #10）：macOS 的 realpath 大小寫與 NFC／NFD 行為；這裡不依賴它，
 * 一律在比對時折疊。硬連結、TOCTOU 為已接受的範圍外。
 */

import * as fs from 'fs';
import * as path from 'path';

import { WRITE_GUARD_MAX_SYMLINK_HOPS } from '../constants.js';

export interface PathNormalizer {
  /** 工具欄位中的路徑 -> 解過 symlink 的絕對路徑；無法判斷時回 null。 */
  normalizeTarget(raw: string, cwd: string): string | null;
  /** 已存在的根目錄 -> realpath 後的絕對路徑；不存在或無法解析時回 null。 */
  normalizeRoot(root: string): string | null;
  /** target 是否等於 root 或位於 root 之下（兩者都必須是正規化後的結果）。 */
  isWithin(target: string, root: string): boolean;
}

export interface PathNormalizerOptions {
  /** 決定分隔字元（只有 win32 把 `\` 當分隔字元）與是否折疊大小寫；預設為目前平台。 */
  platform?: NodeJS.Platform;
}

/**
 * 平台的路徑語意：分隔字元、parse／join／relative 等全部依此決定，沒有其他切段方式。
 * darwin、linux 等非 win32 平台上 `\` 是檔名中的普通字元（作業系統不把它當分隔字元），
 * 因此 `x\..\..\y.md` 是同一段檔名，絕不能被切開再消去 `..`（P2 驗證 D1）。
 */
interface PlatformPaths {
  api: typeof path.posix;
  separators: RegExp;
}

function platformPaths(platform: NodeJS.Platform): PlatformPaths {
  return platform === 'win32'
    ? { api: path.win32, separators: /[\\/]+/ }
    : { api: path.posix, separators: /\/+/ };
}

function splitComponents(rest: string, paths: PlatformPaths): string[] {
  return rest.split(paths.separators).filter((part) => part.length > 0);
}

function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 以作業系統語意逐段解析一個絕對路徑。已存在的部分逐段 lstat，symlink 以
 * readlink 的目標展開（相對目標相對於連結所在目錄）；第一個不存在的部分之後
 * 照字面接回，直到 `..` 回到已存在的層級。任何非「不存在」的錯誤、或 symlink
 * 次數超過上限，都回 null。
 */
function resolveOsPath(absolute: string, paths: PlatformPaths): string | null {
  const { api } = paths;
  const root = api.parse(absolute).root;
  if (root.length === 0) return null;
  let current = root;
  const pending = splitComponents(absolute.slice(root.length), paths);
  let missingDepth = 0;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      current = api.dirname(current);
      if (missingDepth > 0) missingDepth--;
      continue;
    }
    const next = api.join(current, part);
    if (missingDepth > 0) {
      current = next;
      missingDepth++;
      continue;
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(next);
    } catch (err) {
      if (!isMissingError(err)) return null;
      current = next;
      missingDepth = 1;
      continue;
    }
    if (!stats.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > WRITE_GUARD_MAX_SYMLINK_HOPS) return null;
    let target: string;
    try {
      target = fs.readlinkSync(next);
    } catch {
      return null;
    }
    const targetRoot = api.isAbsolute(target) ? api.parse(target).root : '';
    if (targetRoot.length > 0) current = targetRoot;
    pending.unshift(...splitComponents(target.slice(targetRoot.length), paths));
  }
  return current;
}

/** 比對用的鍵：darwin、win32 折疊大小寫（darwin 另做 NFC）。不切段，只改字元。 */
function comparisonKey(value: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return value.normalize('NFC').toLowerCase();
  if (platform === 'win32') return value.toLowerCase();
  return value;
}

/** 「先字面消去 `..` 再解析」的候選來源；路徑沒有 `..` 段（依平台切段）時回 null。 */
function lexicalCandidate(raw: string, cwd: string, paths: PlatformPaths): string | null {
  if (!splitComponents(raw, paths).includes('..')) return null;
  if (paths.api.isAbsolute(raw)) return paths.api.resolve(raw);
  return paths.api.isAbsolute(cwd) ? paths.api.resolve(cwd, raw) : null;
}

/** createPathNormalizer 產生的實作另外帶著平台語意，供 normalizeTargetCandidates 使用。 */
const platformOf = new WeakMap<PathNormalizer, PlatformPaths>();

export function createPathNormalizer(options: PathNormalizerOptions = {}): PathNormalizer {
  const platform = options.platform ?? process.platform;
  const paths = platformPaths(platform);
  const { api } = paths;
  const normalizer: PathNormalizer = {
    normalizeTarget(raw, cwd) {
      if (raw.length === 0 || raw.includes('\0') || cwd.includes('\0')) return null;
      let absolute: string;
      if (api.isAbsolute(raw)) {
        absolute = raw;
      } else {
        // 相對路徑只能以 payload 的 cwd 解析；沒有可用的 cwd 就不猜（fail-closed）。
        if (!api.isAbsolute(cwd)) return null;
        // 刻意不用 join／resolve：它們會先以字面消去 `..`。
        absolute = `${cwd}${api.sep}${raw}`;
      }
      return resolveOsPath(absolute, paths);
    },
    normalizeRoot(root) {
      if (!api.isAbsolute(root) || root.includes('\0')) return null;
      try {
        return fs.realpathSync(api.resolve(root));
      } catch {
        return null;
      }
    },
    isWithin(target, root) {
      const relative = api.relative(comparisonKey(root, platform), comparisonKey(target, platform));
      if (relative === '') return true;
      if (api.isAbsolute(relative)) return false;
      // 只把真正的上層跳脫（`..` 或 `../...`）視為在外面；名為 `..foo` 的目錄仍在裡面。
      return relative !== '..' && !relative.startsWith(`..${api.sep}`);
    },
  };
  platformOf.set(normalizer, paths);
  return normalizer;
}

/** 兩個正規化後的路徑是否指同一處（依平台折疊大小寫；走 isWithin 的同一套語意）。 */
export function samePath(normalizer: PathNormalizer, a: string, b: string): boolean {
  return normalizer.isWithin(a, b) && normalizer.isWithin(b, a);
}

/**
 * hook 端使用：一個原始路徑的所有候選（作業系統語意，加上「先字面消去 `..`」）。
 * 任一候選無法判斷就整體回 null（fail-closed，F7）。切段與字面消去依 normalizer 的
 * 平台；不是 createPathNormalizer 產生的 normalizer（例如測試的包裝）用目前平台。
 */
export function normalizeTargetCandidates(
  normalizer: PathNormalizer,
  raw: string,
  cwd: string,
): string[] | null {
  const osSemantic = normalizer.normalizeTarget(raw, cwd);
  if (osSemantic === null) return null;
  const candidates = [osSemantic];
  const lexical = lexicalCandidate(
    raw,
    cwd,
    platformOf.get(normalizer) ?? platformPaths(process.platform),
  );
  if (lexical !== null) {
    const resolved = normalizer.normalizeTarget(lexical, cwd);
    if (resolved === null) return null;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  return candidates;
}

/** 目前平台的路徑正規化實作。 */
export const pathNormalizer: PathNormalizer = createPathNormalizer();
