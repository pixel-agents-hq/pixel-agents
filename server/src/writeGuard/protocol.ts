/**
 * 阻擋式裁決通道的請求與回應格式（hook <-> 伺服器）。
 *
 * 這份格式只在本機 hook 與本機伺服器之間流通，不屬於 webview 協定
 * （core/asyncapi.yaml），因此不產生 messages.ts 的變更。
 *
 * F9：請求只含 tool_name、路徑欄位、command、cwd、session_id，絕不含檔案內容
 * （Write 的 content、Edit 的 old_string/new_string）。路徑是 hook 端已做過
 * realpath 的絕對路徑（F13：伺服器端不做任何檔案系統呼叫）。
 */

import type { GuardOperation } from './bashTypes.js';

/** hook 送給伺服器的裁決請求。欄位名沿用 Claude Code payload 的蛇形命名。 */
export interface GuardRequest {
  tool_name: string;
  session_id: string;
  cwd: string;
  /** hook 端正規化（realpath）後的絕對路徑。 */
  paths: string[];
  /**
   * Bash 的原始指令字串（P3：伺服器自己再解析一次，用於角色分類與以 Agent Directory
   * 為起點的字面候選）。指令過長或請求過大時不送（見 bash_ops）。
   */
  command?: string;
  /**
   * 寫入類工具的路徑抽不到、或至少一個路徑無法正規化（F7）；Bash 的寫入目標無法判斷
   * （P3）。只在為 true 時出現；伺服器在 KB 規則啟用時一律 deny。
   */
  unresolved?: true;
  /** P3：Bash 遞迴命中的目標（rm、mv 的來源、find -delete 的起點等），hook 端正規化後。 */
  recursive_paths?: string[];
  /** P3：直譯器與無法分類指令中字面出現的路徑片段，hook 端正規化後。 */
  mentioned_paths?: string[];
  /**
   * P3：hook 端解析出的操作類別。只在沒有送 command 時（指令過長、請求過大）由伺服器
   * 採用；有 command 時伺服器以自己的解析為準。
   */
  bash_ops?: GuardOperation[];
}

/** 伺服器的三態裁決（F4）。deny 只帶規則識別碼、（請求內的）路徑與（P3）觸發規則的
 *  指令名稱片段，不帶任何自由文字；hook 只在片段確實出自這次指令時才放進訊息。 */
export type GuardVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny'; rule: string; path?: string; fragment?: string }
  | { verdict: 'unknown-session' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const OPERATIONS: readonly GuardOperation[] = ['read', 'edit', 'delete'];

function isOperationArray(value: unknown): value is GuardOperation[] {
  return Array.isArray(value) && value.every((v) => OPERATIONS.includes(v as GuardOperation));
}

/** 伺服器端驗證請求形狀；不合格回 null（端點回 400）。多餘欄位一律丟棄。 */
export function parseGuardRequest(body: unknown): GuardRequest | null {
  if (!isRecord(body)) return null;
  const { tool_name, session_id, cwd, paths, command, unresolved } = body;
  const { recursive_paths, mentioned_paths, bash_ops } = body;
  if (typeof tool_name !== 'string' || tool_name.length === 0) return null;
  if (typeof session_id !== 'string' || session_id.length === 0) return null;
  if (typeof cwd !== 'string') return null;
  if (!isStringArray(paths)) return null;
  if (command !== undefined && typeof command !== 'string') return null;
  if (unresolved !== undefined && typeof unresolved !== 'boolean') return null;
  if (recursive_paths !== undefined && !isStringArray(recursive_paths)) return null;
  if (mentioned_paths !== undefined && !isStringArray(mentioned_paths)) return null;
  if (bash_ops !== undefined && !isOperationArray(bash_ops)) return null;
  return {
    tool_name,
    session_id,
    cwd,
    paths: [...paths],
    ...(command !== undefined ? { command } : {}),
    ...(unresolved === true ? { unresolved: true as const } : {}),
    ...(recursive_paths !== undefined ? { recursive_paths: [...recursive_paths] } : {}),
    ...(mentioned_paths !== undefined ? { mentioned_paths: [...mentioned_paths] } : {}),
    ...(bash_ops !== undefined ? { bash_ops: [...bash_ops] } : {}),
  };
}

/** hook 端驗證伺服器回應；不合格回 null（視同伺服器沒有回答）。 */
export function parseGuardVerdict(body: unknown): GuardVerdict | null {
  if (!isRecord(body)) return null;
  if (body.verdict === 'allow') return { verdict: 'allow' };
  if (body.verdict === 'unknown-session') return { verdict: 'unknown-session' };
  if (body.verdict === 'deny') {
    if (typeof body.rule !== 'string') return null;
    if (body.path !== undefined && typeof body.path !== 'string') return null;
    if (body.fragment !== undefined && typeof body.fragment !== 'string') return null;
    return {
      verdict: 'deny',
      rule: body.rule,
      ...(body.path !== undefined ? { path: body.path } : {}),
      ...(body.fragment !== undefined ? { fragment: body.fragment } : {}),
    };
  }
  return null;
}
