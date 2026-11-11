export const AGENT_CREATED_NOTICE = '已建立 Agent';
export const AGENT_CREATION_TIMEOUT_NOTICE =
  '伺服器沒有回應。請到工作空間確認 Agent 是否已建立，再決定要不要重送';

/** 導覽時順帶傳給目的頁、只顯示一次的成功訊息。 */
export interface NoticeState {
  notice: string;
}

export function noticeState(notice: string): NoticeState {
  return { notice };
}

/** 從 router 的 location.state 取出成功訊息；不是這個形狀就當作沒有。 */
export function noticeFrom(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const notice = (state as { notice?: unknown }).notice;
  return typeof notice === 'string' && notice !== '' ? notice : null;
}
