/**
 * hook 對 Claude Code 輸出「拒絕」決定的唯一位置（F1）。
 *
 * 假設（未實測，見計畫「P0 上線後實測清單」第 1、2、3 項）：依官方文件回報，
 * PreToolUse hook 以 exit 0 加下列 JSON 即可拒絕該次工具呼叫，且
 * permissionDecisionReason 會交給模型。上線實測若推翻此格式，只改這個函式。
 *
 * 刻意沒有「允許」的輸出：伺服器回 allow 時 hook 什麼都不輸出、exit 0。
 * 輸出 permissionDecision allow 會讓全域安裝的 hook 替本機所有 session
 * 自動核准工具呼叫（F1）。
 */

const HOOK_EVENT_NAME = 'PreToolUse';
const DENY_DECISION = 'deny';

/** 拒絕決定的 stdout 內容（exit code 一律為 0）。 */
export function formatDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: DENY_DECISION,
      permissionDecisionReason: reason,
    },
  });
}
