/**
 * hook 端的 Bash 本地判斷（P3 補充決定 4、6）：在任何網路呼叫之前解析指令、正規化
 * 寫入目標，讓伺服器不可達時的 KB 區 fail-closed 也涵蓋 Bash（F2）。
 *
 * 只用 payload cwd 當相對路徑的起點（hook 不知道 Agent Directory；以 Agent Directory
 * 為起點的候選由伺服器在裁決時加上）。角色與 F17 不在這裡判斷（伺服器不可達時不生效）。
 */

import {
  WRITE_GUARD_BASH_LOCAL_DEADLINE_MS,
  WRITE_GUARD_BASH_MAX_PARSE_BYTES,
} from '../../../../constants.js';
import { analyzeBash } from '../../../../writeGuard/bashAnalysis.js';
import { literalZonePaths } from '../../../../writeGuard/bashLiteralScan.js';
import { resolveBashPaths } from '../../../../writeGuard/bashPaths.js';
import type { GuardOperation } from '../../../../writeGuard/bashTypes.js';
import type { PathNormalizer } from '../../../../writeGuard/pathNormalization.js';
import { platformFor } from '../../../../writeGuard/pathNormalization.js';

export interface BashLocalPlan {
  /** 直接寫入的目標（正規化後）。 */
  direct: string[];
  /** 遞迴命中的目標：落在受保護區內，或受保護區落在其下，都算命中。 */
  recursive: string[];
  /** 直譯器與無法分類指令中的字面路徑片段（視為潛在寫入）。 */
  mentioned: string[];
  /** 非讀取類指令的解碼後文字（子字串包含掃描用）。 */
  literalTexts: string[];
  /** 指令過長、沒有 command、巢狀或數量超過上限、路徑無法正規化。 */
  unresolved: boolean;
  /** 解析出的操作類別；指令無法解析時為 null。 */
  ops: GuardOperation[] | null;
  /** 這次指令中各簡單指令的名稱（拒絕訊息只放這些片段）。 */
  fragments: string[];
}

/** 無法解析（例外、預算或時鐘用完、指令過長）：三種操作類別、寫入目標無法判斷，
 *  KB 啟用時 fail-closed。 */
function unparseablePlan(): BashLocalPlan {
  return {
    direct: [],
    recursive: [],
    mentioned: [],
    literalTexts: [],
    unresolved: true,
    ops: ['read', 'edit', 'delete'],
    fragments: [],
  };
}

/**
 * 永不拋出（驗證 F-1）：例外一律視為無法解析，而不是讓 planGuard 失敗而放行。
 * 時鐘防線（第二次驗證 P1-1）：本地解析加路徑正規化超過 WRITE_GUARD_BASH_LOCAL_DEADLINE_MS
 * 就放棄並視為無法解析；now 可注入（測試）。
 */
export function planBash(
  command: string | undefined,
  cwd: string,
  home: string,
  normalizer: PathNormalizer,
  now: () => number = Date.now,
): BashLocalPlan {
  try {
    return planParsed(command, cwd, home, normalizer, now);
  } catch {
    return unparseablePlan();
  }
}

function planParsed(
  command: string | undefined,
  cwd: string,
  home: string,
  normalizer: PathNormalizer,
  now: () => number,
): BashLocalPlan {
  if (command === undefined || Buffer.byteLength(command) > WRITE_GUARD_BASH_MAX_PARSE_BYTES) {
    // 超過 1 MiB 不解析：與巢狀超限相同，需要 edit 與 delete（不能用填充夾帶 rm）。
    return { ...unparseablePlan(), ops: ['edit', 'delete'] };
  }
  const deadline = now() + WRITE_GUARD_BASH_LOCAL_DEADLINE_MS;
  const expired = (): boolean => now() > deadline;
  const analysis = analyzeBash(command, { platform: platformFor(normalizer) });
  if (expired()) return unparseablePlan();
  const resolved = resolveBashPaths(analysis, cwd, home, normalizer, expired);
  if (expired()) return unparseablePlan();
  return {
    direct: resolved.direct,
    recursive: resolved.recursive,
    mentioned: resolved.mentioned,
    literalTexts: analysis.literalTexts,
    unresolved: resolved.unresolved,
    ops: analysis.ops,
    fragments: Object.values(analysis.opSources).filter((f): f is string => f !== undefined),
  };
}

/** 本地清單的受保護根目錄是否被這次 Bash 命中（fail-closed 用）。 */
export function bashHitsRoot(
  plan: BashLocalPlan,
  roots: readonly string[],
  normalizer: PathNormalizer,
): string | undefined {
  const within = (p: string): boolean => roots.some((root) => normalizer.isWithin(p, root));
  return (
    plan.direct.find(within) ??
    plan.mentioned.find(within) ??
    plan.recursive.find((p) => within(p) || roots.some((root) => normalizer.isWithin(root, p))) ??
    // 根目錄含空白等情況：文字「包含」受保護區根目錄（第二次驗證 P2-4）。
    literalZonePaths(plan.literalTexts, roots, normalizer).find(within)
  );
}
