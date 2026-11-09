/**
 * 欄位抽取（P1 定義介面，P2 替換實作；claude-hook.ts 不需要再修改）。
 *
 * 從 Claude Code 的 PreToolUse payload 取出裁決需要的欄位，且只取這些欄位
 * （F9：不取 Write 的 content、Edit 的 old_string/new_string 等檔案內容）。
 *
 * P2 的實作：
 * - Write、Edit：`tool_input.file_path`；
 * - NotebookEdit：`tool_input.notebook_path` 與 `tool_input.file_path`（兩個都收）；
 * - Bash：只回傳原始 `tool_input.command`；解析與路徑抽取在 hookGuard（P3，bashAnalysis.ts），
 *   這裡維持純粹的欄位抽取；
 * - Read、Glob、Grep（P3）：只回傳公共欄位，供伺服器判斷權限角色 R；
 * - 其他工具、其他事件：回 null（不裁決）。
 *
 * 寫入類工具（WRITE_GUARD_FILE_WRITE_TOOLS）抽不到任何路徑時 pathFields 為空陣列，
 * 由 hookGuard 標記為 unresolved（F7：KB 規則一律 deny）。
 *
 * 假設（未實測，見計畫「P0 上線後實測清單」第 5、9 項）：欄位名與官方文件回報一致
 * （Write/Edit 為 file_path、NotebookEdit 為 notebook_path、Bash 為 command，
 * 公共欄位為 session_id、cwd、tool_name）。
 */

import {
  WRITE_GUARD_BASH_TOOL,
  WRITE_GUARD_FILE_WRITE_TOOLS,
  WRITE_GUARD_READ_TOOLS,
} from '../../../../constants.js';

/** 裁決需要的欄位。pathFields 為原始字串，正規化由 PathNormalizer 負責。 */
export interface GuardFields {
  toolName: string;
  sessionId: string;
  cwd: string;
  pathFields: string[];
  command?: string;
}

export type FieldExtractor = (payload: Record<string, unknown>) => GuardFields | null;

const PRE_TOOL_USE_EVENT = 'PreToolUse';
/** 每種寫入類工具攜帶目標路徑的欄位（依序收集，全部字串欄位都算）。 */
const PATH_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 這個工具是否為寫入類檔案工具（F7 的對象）。 */
export function isFileWriteTool(toolName: string): boolean {
  return WRITE_GUARD_FILE_WRITE_TOOLS.includes(toolName);
}

function extract(payload: Record<string, unknown>): GuardFields | null {
  if (payload.hook_event_name !== PRE_TOOL_USE_EVENT) return null;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = payload;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof toolName !== 'string') return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const input = isRecord(toolInput) ? toolInput : {};

  if (isFileWriteTool(toolName)) {
    const pathFields: string[] = [];
    for (const field of PATH_FIELDS_BY_TOOL[toolName] ?? []) {
      const value = input[field];
      if (typeof value === 'string' && !pathFields.includes(value)) pathFields.push(value);
    }
    return { toolName, sessionId, cwd, pathFields };
  }
  if (toolName === WRITE_GUARD_BASH_TOOL) {
    const command = input.command;
    return {
      toolName,
      sessionId,
      cwd,
      pathFields: [],
      ...(typeof command === 'string' ? { command } : {}),
    };
  }
  // P3：讀取類工具只為了權限角色（R）而裁決；不需要任何路徑或內容。
  if (WRITE_GUARD_READ_TOOLS.includes(toolName))
    return { toolName, sessionId, cwd, pathFields: [] };
  return null;
}

/** P2 的欄位抽取實作（P3 加上讀取類工具）。 */
export const extractGuardFields: FieldExtractor = extract;
