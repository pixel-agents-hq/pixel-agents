/**
 * 受保護根目錄清單與已知 standalone session 清單（每台 standalone 伺服器一份）。
 *
 * 位置：`~/.pixel-agents/guard/<pid>-<port>.json`，與該伺服器的 registry 項目
 * （`~/.pixel-agents/servers/<pid>-<port>.json`）同名。這是執行期檔案：伺服器
 * 停止時刪除，啟動時清掉 PID 已死的殘檔；刪掉它只會讓規則對該伺服器失效。
 *
 * 用途是讓 hook 在任何網路呼叫之前，就能在本地判斷「這是不是已知 standalone
 * session 對受保護路徑的寫入」（F2、F3）：伺服器不可達時，只有這種寫入 fail-closed。
 *
 * 寫出端只有伺服器（WriteGuard）；VS Code 內嵌伺服器從不寫（分流）。
 */

import * as fs from 'fs';
import * as path from 'path';

import { SERVER_JSON_DIR, WRITE_GUARD_LIST_VERSION, WRITE_GUARD_LISTS_DIR } from '../constants.js';

export interface GuardList {
  version: number;
  /** 寫出這份清單的伺服器；hook 只在與 registry 項目一致時採認。 */
  pid: number;
  port: number;
  /** 已 realpath 的受保護根目錄。 */
  protectedRoots: string[];
  /** 本伺服器以 PTY 啟動、目前仍存活的 Agent 的 session id。 */
  knownSessions: string[];
}

/** 清單所屬的伺服器（registry 項目的識別）。 */
export interface GuardListOwner {
  pid: number;
  port: number;
}

export function guardListsDir(homeDir: string): string {
  return path.join(homeDir, SERVER_JSON_DIR, WRITE_GUARD_LISTS_DIR);
}

export function guardListPath(homeDir: string, owner: GuardListOwner): string {
  return path.join(guardListsDir(homeDir), `${owner.pid}-${owner.port}.json`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** 驗證清單內容；格式不對、版本不同或擁有者不一致都回 null（視同沒有清單）。 */
export function parseGuardList(value: unknown, owner: GuardListOwner): GuardList | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== WRITE_GUARD_LIST_VERSION) return null;
  if (record.pid !== owner.pid || record.port !== owner.port) return null;
  if (!isStringArray(record.protectedRoots) || !isStringArray(record.knownSessions)) return null;
  return {
    version: WRITE_GUARD_LIST_VERSION,
    pid: owner.pid,
    port: owner.port,
    protectedRoots: [...record.protectedRoots],
    knownSessions: [...record.knownSessions],
  };
}

/** hook 端讀取；任何錯誤都回 null。 */
export function readGuardList(homeDir: string, owner: GuardListOwner): GuardList | null {
  try {
    const raw = fs.readFileSync(guardListPath(homeDir, owner), 'utf-8');
    return parseGuardList(JSON.parse(raw) as unknown, owner);
  } catch {
    return null;
  }
}

/** 伺服器端寫出（tmp + rename，0600；目錄 0700）。失敗回 false 並記錄。 */
export function writeGuardList(homeDir: string, list: GuardList): boolean {
  const filePath = guardListPath(homeDir, list);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Write guard: failed to write ${filePath}: ${String(err)}`);
    return false;
  }
}

/** 刪除自己的清單（只刪自己的，與 registry 項目的自我清理相同）。 */
export function removeGuardList(homeDir: string, owner: GuardListOwner): void {
  try {
    fs.unlinkSync(guardListPath(homeDir, owner));
  } catch {
    // 已經不在了
  }
}

/** 清掉 PID 已死的伺服器留下的清單（當機、SIGKILL 後的殘檔）。 */
export function pruneDeadGuardLists(homeDir: string, isAlive: (pid: number) => boolean): void {
  const dir = guardListsDir(homeDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const match = /^(\d+)-\d+\.json(?:\.tmp)?$/.exec(file);
    if (!match) continue;
    if (isAlive(Number(match[1]))) continue;
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // 已經不在了
    }
  }
}
