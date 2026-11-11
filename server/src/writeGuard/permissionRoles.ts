/**
 * 權限角色（P3 補充決定 1 到 3）。純函式，只讀記憶體。
 *
 * - R、E、D 是三個獨立開關：一個 Agent 的角色是集合。操作分 read、edit、delete，
 *   操作所需的類別必須在集合內才放行（R 對應 read、E 對應 edit、D 對應 delete）。
 * - null（沒設角色）等於全開，角色規則完全不生效，行為與 P3 之前相同。
 * - 空陣列等於三個開關全關：需要 read、edit、delete 的工具呼叫一律被拒。
 * - 工具：Read、Glob、Grep 需要 read；Write、Edit、NotebookEdit 需要 edit；
 *   Bash 依解析結果；其他工具不受角色限制（已知限制）。
 */

import {
  PERMISSION_ROLES,
  WRITE_GUARD_FILE_WRITE_TOOLS,
  WRITE_GUARD_READ_TOOLS,
  WRITE_GUARD_RULE_ROLE_DELETE,
  WRITE_GUARD_RULE_ROLE_EDIT,
  WRITE_GUARD_RULE_ROLE_READ,
} from '../constants.js';
import type { GuardOperation } from './bashTypes.js';

export type PermissionRole = (typeof PERMISSION_ROLES)[number];

/** 角色設定的值：集合（依 R、E、D 順序），或 null（沒設角色，全開）。 */
export type PermissionRoles = readonly PermissionRole[] | null;

const ROLE_OF_OPERATION: Readonly<Record<GuardOperation, PermissionRole>> = {
  read: 'R',
  edit: 'E',
  delete: 'D',
};

export const RULE_OF_OPERATION: Readonly<Record<GuardOperation, string>> = {
  read: WRITE_GUARD_RULE_ROLE_READ,
  edit: WRITE_GUARD_RULE_ROLE_EDIT,
  delete: WRITE_GUARD_RULE_ROLE_DELETE,
};

function isPermissionRole(value: unknown): value is PermissionRole {
  return typeof value === 'string' && (PERMISSION_ROLES as readonly string[]).includes(value);
}

/**
 * 驗證來自客戶端或持久化檔案的角色值。只接受 null，或只含 R、E、D 且不重複的陣列
 * （空陣列合法：全部關閉）。結果依 R、E、D 順序；不合格回 undefined。
 */
export function parsePermissionRoles(value: unknown): PermissionRoles | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  if (!value.every(isPermissionRole)) return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return PERMISSION_ROLES.filter((role) => value.includes(role));
}

/** 非 Bash 工具需要的操作類別；不受角色限制的工具回空陣列。 */
export function toolOperations(toolName: string): GuardOperation[] {
  if (WRITE_GUARD_READ_TOOLS.includes(toolName)) return ['read'];
  if (WRITE_GUARD_FILE_WRITE_TOOLS.includes(toolName)) return ['edit'];
  return [];
}

/** 第一個角色集合不允許的操作類別（依 read、edit、delete）；全部允許或沒設角色時回 null。 */
export function missingOperation(
  roles: PermissionRoles,
  ops: readonly GuardOperation[],
): GuardOperation | null {
  if (roles === null) return null;
  return ops.find((op) => !roles.includes(ROLE_OF_OPERATION[op])) ?? null;
}

/**
 * 有效角色（啟動時快照）：啟動覆寫（含明確的 null）優先，否則工作空間預設，否則 null。
 * override 為 undefined 表示啟動時沒有帶這個欄位。
 */
export function effectivePermissionRoles(
  override: PermissionRoles | undefined,
  workspaceDefault: PermissionRoles | undefined,
): PermissionRoles {
  if (override !== undefined) return override;
  return workspaceDefault ?? null;
}
