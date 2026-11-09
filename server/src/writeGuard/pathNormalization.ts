/**
 * 路徑正規化介面（P1 定義，P2 替換實作；claude-hook.ts 不需要再修改）。
 *
 * 同一份實作同時用在兩端，兩端才能比對得起來：
 * - hook 端：把工具欄位裡的路徑（可能是相對路徑、可能尚未存在）轉成 realpath 後的絕對路徑；
 * - 伺服器端：寫出受保護根目錄清單之前，先把根目錄做 realpath（寫清單時做，
 *   不在裁決時做，F13）。
 *
 * P1 的實作是最小版本：相對路徑以 payload cwd 解析、`..` 先以字面規則消去，
 * 再對「最深的已存在上層」做 realpath 後接回其餘部分（新檔案也能比對）。
 * 大小寫、NFC/NFD、`a/symlink/../b` 這類語意差異留給 P2（F8）。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PathNormalizer {
  /** 工具欄位中的路徑 -> realpath 後的絕對路徑；無法判斷時回 null。 */
  normalizeTarget(raw: string, cwd: string): string | null;
  /** 受保護根目錄 -> realpath 後的絕對路徑；不存在或無法解析時回 null。 */
  normalizeRoot(root: string): string | null;
  /** target 是否等於 root 或位於 root 之下（兩者都必須是正規化後的結果）。 */
  isWithin(target: string, root: string): boolean;
}

/** 對最深的已存在上層做 realpath，再把尚未存在的部分接回去。 */
function realpathDeepestExisting(absolute: string): string | null {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const resolved = fs.realpathSync(current);
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function normalizeTarget(raw: string, cwd: string): string | null {
  if (raw.length === 0 || raw.includes('\0')) return null;
  let absolute: string;
  if (path.isAbsolute(raw)) {
    absolute = path.resolve(raw);
  } else {
    // 相對路徑只能以 payload 的 cwd 解析；沒有可用的 cwd 就不猜。
    if (!path.isAbsolute(cwd)) return null;
    absolute = path.resolve(cwd, raw);
  }
  return realpathDeepestExisting(absolute);
}

function normalizeRoot(root: string): string | null {
  if (!path.isAbsolute(root) || root.includes('\0')) return null;
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return null;
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  // 只把真正的上層跳脫（`..` 或 `../...`）視為在外面；名為 `..foo` 的目錄仍在裡面。
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** P1 的路徑正規化實作。 */
export const pathNormalizer: PathNormalizer = { normalizeTarget, normalizeRoot, isWithin };
