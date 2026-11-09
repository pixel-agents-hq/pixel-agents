/**
 * agentGuardStatus 的狀態計算（P4，純函式）。
 *
 * 判準是證據，不是設定：只有 hook 鏈完整（hooks 已安裝、PreToolUse 項目存在、
 * 腳本存在）且伺服器已實際收過此 session 的裁決請求，規則才算生效（active）。
 * no_workspace_root 與 no_curator 只供顯示，不影響 active。
 */

import type { GuardInactiveReason, PermissionRole } from '../../../core/src/messages.js';

/** hook 鏈的檔案系統檢查結果（固定間隔計算並快取，見 guardChainCheck.ts）。 */
export interface HookChainCheck {
  hooksInstalled: boolean;
  preToolUsePresent: boolean;
  scriptPresent: boolean;
}

export interface GuardStatusInputs {
  /** 是本行程以 PTY 啟動、且仍由本伺服器持有的 Agent。 */
  isStandaloneAgent: boolean;
  chain: HookChainCheck;
  /** 伺服器是否已收過此 session 的裁決請求。 */
  verdictSeen: boolean;
  /** Agent 所屬工作空間是否設定根目錄。 */
  workspaceHasRoot: boolean;
  /** 該工作空間是否有 curator。 */
  workspaceHasCurator: boolean;
}

export interface GuardStatus {
  active: boolean;
  reasons: GuardInactiveReason[];
}

/** 外部收編、還原等非 PTY Agent 的固定狀態。 */
export const NOT_STANDALONE_STATUS: GuardStatus = {
  active: false,
  reasons: ['not_standalone_agent'],
};

export function computeGuardStatus(inputs: GuardStatusInputs): GuardStatus {
  if (!inputs.isStandaloneAgent)
    return { ...NOT_STANDALONE_STATUS, reasons: ['not_standalone_agent'] };

  const reasons: GuardInactiveReason[] = [];
  const { chain } = inputs;
  if (!chain.hooksInstalled) reasons.push('hooks_not_installed');
  else if (!chain.preToolUsePresent) reasons.push('pretooluse_hook_missing');
  if (!chain.scriptPresent) reasons.push('hook_script_missing');
  if (!inputs.verdictSeen) reasons.push('awaiting_first_verdict');

  const active = reasons.length === 0;
  if (!inputs.workspaceHasRoot) reasons.push('no_workspace_root');
  else if (!inputs.workspaceHasCurator) reasons.push('no_curator');
  return { active, reasons };
}

/** agentGuardStatus 訊息；permissionRoles 原樣取自 Agent 啟動快照。 */
export function guardStatusMessage(
  id: number,
  status: GuardStatus,
  permissionRoles: readonly PermissionRole[] | null,
): Record<string, unknown> {
  return {
    type: 'agentGuardStatus',
    id,
    active: status.active,
    reasons: status.reasons,
    permissionRoles: permissionRoles === null ? null : [...permissionRoles],
  };
}
