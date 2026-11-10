/**
 * 兩種 KB 區的重疊檢查（計畫「規則的核心定義」：realpath 不得相等或互相包含）。
 *
 * 工作空間 KB 區 = `<root>/.note`，個人 KB 區 = `<Directory>/.note`。兩者都先以
 * 作業系統語意正規化（解 symlink；.note 尚不存在時對上層 realpath 再接回），
 * 再依平台折疊大小寫比對。設定根目錄時用它拒絕重疊；執行期若仍出現重疊
 * （例如之後才新增的 Directory），裁決以工作空間規則優先（kbRules.ts）。
 */

import { personalKbZone } from './kbIdentity.js';
import type { PathNormalizer } from './pathNormalization.js';

/** 一個絕對路徑的正規化結果；無法判斷時退回字面路徑（仍可比對）。 */
export function normalizeZone(normalizer: PathNormalizer, absolute: string): string {
  return normalizer.normalizeTarget(absolute, '') ?? absolute;
}

/**
 * 以 `root` 為根目錄的工作空間 KB 區，是否與任何一個 Directory 的個人 KB 區
 * 相等或互相包含。directories 為絕對路徑（可未 realpath）。
 */
export function workspaceKbOverlapsPersonal(
  normalizer: PathNormalizer,
  root: string,
  directories: readonly string[],
): boolean {
  const workspaceZone = normalizeZone(normalizer, personalKbZone(root));
  return directories.some((directory) => {
    const personal = normalizeZone(normalizer, personalKbZone(directory));
    return (
      normalizer.isWithin(personal, workspaceZone) || normalizer.isWithin(workspaceZone, personal)
    );
  });
}
