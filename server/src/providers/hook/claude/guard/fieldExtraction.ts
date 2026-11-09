/**
 * 欄位抽取介面（P1 定義，P2、P3 替換實作；claude-hook.ts 不需要再修改）。
 *
 * 從 Claude Code 的 PreToolUse payload 取出裁決需要的欄位，且只取這些欄位
 * （F9：不取 Write 的 content、Edit 的 old_string/new_string 等檔案內容）。
 *
 * P1 的最小實作：
 * - Write、Edit：`tool_input.file_path`；
 * - Bash：只回傳原始 `tool_input.command`，不解析、不抽路徑（Bash 解析是 P3）；
 * - 其他工具、其他事件：回 null（不裁決）。
 *
 * 假設（未實測，見計畫「P0 上線後實測清單」第 5、9 項）：欄位名與官方文件回報一致
 * （Write/Edit 為 file_path、Bash 為 command，公共欄位為 session_id、cwd、tool_name）。
 */

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
/** 以 file_path 指定寫入目標的工具。 */
const FILE_PATH_TOOLS: readonly string[] = ['Write', 'Edit'];
const BASH_TOOL = 'Bash';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extract(payload: Record<string, unknown>): GuardFields | null {
  if (payload.hook_event_name !== PRE_TOOL_USE_EVENT) return null;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = payload;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof toolName !== 'string') return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const input = isRecord(toolInput) ? toolInput : {};

  if (FILE_PATH_TOOLS.includes(toolName)) {
    const filePath = input.file_path;
    return {
      toolName,
      sessionId,
      cwd,
      pathFields: typeof filePath === 'string' ? [filePath] : [],
    };
  }
  if (toolName === BASH_TOOL) {
    const command = input.command;
    return {
      toolName,
      sessionId,
      cwd,
      pathFields: [],
      ...(typeof command === 'string' ? { command } : {}),
    };
  }
  return null;
}

/** P1 的欄位抽取實作。 */
export const extractGuardFields: FieldExtractor = extract;
