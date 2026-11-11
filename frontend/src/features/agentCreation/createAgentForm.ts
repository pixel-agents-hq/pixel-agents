/** 表單送出的 Path：前後空白不屬於路徑，伺服器也拒絕帶空白的路徑，所以先修剪。 */
export function normalizeAgentPath(raw: string): string {
  return raw.trim();
}

/** 建立按鈕只看工作空間與 Path；Name、Roles、啟用、KB Writer 都是可選的，不影響能否送出。 */
export function canCreateAgent(workspaceId: string, rawPath: string, pending: boolean): boolean {
  return !pending && workspaceId !== '' && normalizeAgentPath(rawPath) !== '';
}
