import { GUARD_REASON_LABELS, GUARD_TEXT } from '../../constants';
import type { AgentGuard } from './agentsSlice';

export type GuardTone = 'ok' | 'warn' | 'neutral';

export interface GuardLine {
  label: string;
  value: string;
  tone: GuardTone;
  /** 附在值後面的伺服器字串（路徑、名稱），以純文字輸出 */
  detail?: string;
}

export interface GuardStatusView {
  /** 只有 Hook 鏈運作且規則已啟用時才宣稱保護生效 */
  protectedSummary: boolean;
  lines: GuardLine[];
  otherReasons: string[];
}

const HOOK_BROKEN_REASONS: string[] = [
  'hooks_not_installed',
  'pretooluse_hook_missing',
  'hook_script_missing',
];
const THREE_LINE_REASONS: string[] = [
  ...HOOK_BROKEN_REASONS,
  'awaiting_first_verdict',
  'no_workspace_root',
  'no_curator',
];

/** 伺服器給的原因代碼當字串處理：沒看過的代碼直接顯示原文，不做查表失敗。 */
export function reasonLabel(reason: string): string {
  return GUARD_REASON_LABELS[reason] ?? reason;
}

function hookLine(guard: AgentGuard): GuardLine {
  const reasons: string[] = guard.reasons;
  const label = GUARD_TEXT.hookLabel;
  if (reasons.some((reason) => HOOK_BROKEN_REASONS.includes(reason))) {
    return { label, value: GUARD_TEXT.hookBroken, tone: 'warn' };
  }
  if (reasons.includes('awaiting_first_verdict')) {
    return { label, value: GUARD_TEXT.hookAwaiting, tone: 'neutral' };
  }
  if (reasons.includes('not_standalone_agent')) {
    return { label, value: GUARD_TEXT.hookNotApplicable, tone: 'neutral' };
  }
  if (guard.active) return { label, value: GUARD_TEXT.hookVerified, tone: 'ok' };
  return { label, value: GUARD_TEXT.hookUnknown, tone: 'neutral' };
}

/**
 * 伺服器在沒有根目錄時不會送 no_curator，所以「沒有 no_curator」不代表有人被指定；
 * 是否有 KB Writer 以工作空間實際記錄的名稱為準。
 */
function curatorLine(reasons: string[], curatorName: string | null): GuardLine {
  const label = GUARD_TEXT.curatorLabel;
  if (reasons.includes('no_curator')) return { label, value: GUARD_TEXT.curatorNone, tone: 'warn' };
  if (curatorName !== null) return { label, value: curatorName, tone: 'ok' };
  return { label, value: GUARD_TEXT.curatorUnassigned, tone: 'neutral' };
}

export function buildGuardStatus(
  guard: AgentGuard,
  rootPath: string | undefined,
  curatorName: string | null,
): GuardStatusView {
  const reasons: string[] = guard.reasons;
  const rulesOn = !reasons.includes('no_workspace_root');
  return {
    protectedSummary: guard.active && rulesOn,
    lines: [
      hookLine(guard),
      rulesOn
        ? { label: GUARD_TEXT.rulesLabel, value: GUARD_TEXT.rulesOn, tone: 'ok', detail: rootPath }
        : { label: GUARD_TEXT.rulesLabel, value: GUARD_TEXT.rulesOff, tone: 'warn' },
      curatorLine(reasons, curatorName),
    ],
    otherReasons: reasons.filter((reason) => !THREE_LINE_REASONS.includes(reason)).map(reasonLabel),
  };
}
