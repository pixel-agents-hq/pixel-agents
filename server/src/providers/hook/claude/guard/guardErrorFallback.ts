/**
 * hook 端裁決流程本身發生例外時的統一決定（P3，與驗證 F-1 同根因：例外不能導致放行）。
 *
 * 只用最少、最不可能出錯的資料重新判斷，且本身永不拋出：
 * - 不是 PreToolUse、工具不是寫入類（Write、Edit、NotebookEdit、Bash）：放行；
 * - 逐台重新讀取本地清單；讀取拋例外或清單損壞（readList 回 null）的伺服器視為
 *   「無法確認 session 是否已知」，不採計（不能因為不可信的資料對所有人 deny，Q1、F5）；
 * - 有任何一份可信清單列出這個 session，且其 protectedRoots 非空（KB 規則啟用）：deny；
 * - 其餘一律放行。
 * 拒絕訊息使用固定範本（guard-error），不帶例外內容或任何路徑（F16）。
 */

import {
  WRITE_GUARD_ERROR_FAIL_CLOSED_TOOLS,
  WRITE_GUARD_RULE_GUARD_ERROR,
} from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { renderDenyMessage } from '../../../../writeGuard/denyMessage.js';
import type { GuardList } from '../../../../writeGuard/guardList.js';

type Decision = { decision: 'allow' } | { decision: 'deny'; reason: string };

const ALLOW: Decision = { decision: 'allow' };
const PRE_TOOL_USE_EVENT = 'PreToolUse';

export interface GuardErrorDeps {
  readList(server: ServerConfig): GuardList | null;
  log?(line: string): void;
}

function isStandalone(server: ServerTarget | ServerConfig): server is ServerConfig {
  return (server as ServerConfig).standalone !== undefined;
}

/** 讀一台伺服器的清單；任何例外都視為沒有可信清單並記錄。 */
export function readListSafely(deps: GuardErrorDeps, server: ServerConfig): GuardList | null {
  try {
    return deps.readList(server);
  } catch {
    try {
      deps.log?.(`guard-error stage=list port=${String(server.port)}`);
    } catch {
      // 記錄失敗不影響決定
    }
    return null;
  }
}

/** 例外後的決定。永不拋出。 */
export function guardErrorDecision(
  payload: unknown,
  servers: readonly (ServerTarget | ServerConfig)[],
  deps: GuardErrorDeps,
): Decision {
  try {
    if (payload === null || typeof payload !== 'object') return ALLOW;
    const record = payload as Record<string, unknown>;
    if (record.hook_event_name !== PRE_TOOL_USE_EVENT) return ALLOW;
    const tool = record.tool_name;
    const session = record.session_id;
    if (typeof tool !== 'string' || !WRITE_GUARD_ERROR_FAIL_CLOSED_TOOLS.includes(tool)) {
      return ALLOW;
    }
    if (typeof session !== 'string' || session.length === 0) return ALLOW;
    for (const server of servers) {
      if (!isStandalone(server)) continue;
      const list = readListSafely(deps, server);
      if (!list || !Array.isArray(list.knownSessions) || !Array.isArray(list.protectedRoots)) {
        continue;
      }
      if (list.knownSessions.includes(session) && list.protectedRoots.length > 0) {
        return {
          decision: 'deny',
          reason: renderDenyMessage(WRITE_GUARD_RULE_GUARD_ERROR, undefined, []),
        };
      }
    }
    return ALLOW;
  } catch {
    return ALLOW;
  }
}
