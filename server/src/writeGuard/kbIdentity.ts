/**
 * 個人 KB 的識別鍵（計畫 Q6 採 A）。
 *
 * 個人 KB 區是 `<Agent Directory>/.note/` 整棵樹，每個 Agent 只能寫
 * `<Agent Directory>/.note/<識別鍵>/` 之下。識別鍵：
 * - 以角色啟動：S1b 角色檔的 roleId（`<Directory>/.claude/roles/` 的檔名），
 *   必須通過 isValidRoleId（ROLE_ID_PATTERN 加 Windows 裝置名檢查），因此不可能含
 *   路徑分隔字元、`..`、NUL；
 * - 未設角色：KB_PERSONAL_RESERVED_KEY，白名單產生不出來的字串（見 constants.ts）。
 *
 * 同 Directory 同角色的多個 Agent 得到同一個鍵（共用一份，互相可寫，已知限制）；
 * 重啟後以同一 Directory 與角色啟動的新 Agent 也得到同一個鍵。
 */

import * as path from 'path';

import { KB_NOTE_DIR_NAME, KB_PERSONAL_RESERVED_KEY } from '../constants.js';
import { isValidRoleId } from '../roles.js';

/** 識別鍵；roleId 存在但不合白名單時回 null（呼叫端必須拒絕）。 */
export function personalKbKey(roleId: string | undefined): string | null {
  if (roleId === undefined) return KB_PERSONAL_RESERVED_KEY;
  return isValidRoleId(roleId) ? roleId : null;
}

/** 某個 Directory 的個人 KB 區根目錄（`<directory>/.note`），純字串運算。 */
export function personalKbZone(directory: string): string {
  return path.join(directory, KB_NOTE_DIR_NAME);
}

/** 某個 Agent 可寫的子樹（`<directory>/.note/<key>`），純字串運算。 */
export function personalKbOwnRoot(directory: string, key: string): string {
  return path.join(personalKbZone(directory), key);
}
