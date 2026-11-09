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

/** hook 送給伺服器的裁決請求。欄位名沿用 Claude Code payload 的蛇形命名。 */
export interface GuardRequest {
  tool_name: string;
  session_id: string;
  cwd: string;
  /** hook 端正規化（realpath）後的絕對路徑。 */
  paths: string[];
  /** Bash 的原始指令字串；P1 不對它做路徑判斷。 */
  command?: string;
}

/** 伺服器的三態裁決（F4）。deny 只帶規則識別碼與（請求內的）路徑，不帶任何自由文字。 */
export type GuardVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny'; rule: string; path?: string }
  | { verdict: 'unknown-session' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** 伺服器端驗證請求形狀；不合格回 null（端點回 400）。多餘欄位一律丟棄。 */
export function parseGuardRequest(body: unknown): GuardRequest | null {
  if (!isRecord(body)) return null;
  const { tool_name, session_id, cwd, paths, command } = body;
  if (typeof tool_name !== 'string' || tool_name.length === 0) return null;
  if (typeof session_id !== 'string' || session_id.length === 0) return null;
  if (typeof cwd !== 'string') return null;
  if (!isStringArray(paths)) return null;
  if (command !== undefined && typeof command !== 'string') return null;
  return {
    tool_name,
    session_id,
    cwd,
    paths: [...paths],
    ...(command !== undefined ? { command } : {}),
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
    return body.path === undefined
      ? { verdict: 'deny', rule: body.rule }
      : { verdict: 'deny', rule: body.rule, path: body.path };
  }
  return null;
}
