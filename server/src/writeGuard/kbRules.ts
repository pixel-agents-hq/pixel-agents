/**
 * KB 寫入規則與 F17 拒絕清單（P2，取代 P1 的 protectedRootsRule）。只讀記憶體快照
 * （kbState.ts）與 curator 表，不碰檔案系統（F13）。
 *
 * 對一個已知 standalone Agent 的寫入類工具請求（Write、Edit、NotebookEdit），
 * 依序判斷，第一個 deny 即為結果（deny 優先）：
 * 0. 額外受保護根目錄（setProtectedRoots；正式環境不使用，保留 P1 語意）。
 * 1. 路徑抽不到或無法正規化（unresolved）且任一工作空間有根目錄：deny（F7）。
 * 2. 每個路徑：
 *    a. 落在任一工作空間 KB 區：工作空間規則優先，必須是每個命中工作空間的 curator，
 *       且仍在該工作空間；否則 deny（沒有 curator 時建議指派 KB Writer）。
 *    b. 否則落在任一啟用中的個人 KB 區：每個命中的區都必須是自己的區，且路徑在
 *       自己的識別鍵之下；否則 deny（其他識別鍵、無人使用的識別鍵、不屬於任何
 *       識別鍵的檔案都一樣）。
 *    c. 自己的工作空間有根目錄時套用 F17。
 * Bash：bashRules.ts（P3）以 pathWriteVerdict 與 containerVerdict 套用同一套規則。
 * 角色（P3）：guardRules.ts 在這些規則之後判斷（deny 優先，KB 例外不放寬角色，F11）。
 */

import * as path from 'path';

import {
  KB_CLAUDE_SETTINGS_FILE_PATTERN,
  WRITE_GUARD_FILE_WRITE_TOOLS,
  WRITE_GUARD_RULE_KB_PATH_UNRESOLVED,
  WRITE_GUARD_RULE_KB_PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE,
  WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER,
  WRITE_GUARD_RULE_PROTECTED_CONFIG,
  WRITE_GUARD_RULE_PROTECTED_PATH,
} from '../constants.js';
import type { KbAgentInfo, KbState } from './kbState.js';
import type { PathNormalizer } from './pathNormalization.js';
import { samePath } from './pathNormalization.js';
import type { GuardRequest, GuardVerdict } from './protocol.js';

export type RuleVerdict = Exclude<GuardVerdict, { verdict: 'unknown-session' }>;

export interface KbRuleContext {
  agentId: number;
  /** 額外受保護根目錄（setProtectedRoots）。 */
  extraRoots: readonly string[];
  kb: KbState;
  curatorOf(workspaceKey: string): number | null;
  normalizer: PathNormalizer;
}

const ALLOW: RuleVerdict = { verdict: 'allow' };
const deny = (rule: string, p?: string): RuleVerdict =>
  p === undefined ? { verdict: 'deny', rule } : { verdict: 'deny', rule, path: p };

function workspaceZoneVerdict(p: string, ctx: KbRuleContext): RuleVerdict | null {
  const hits = ctx.kb.workspaceZones.filter((z) => ctx.normalizer.isWithin(p, z.zone));
  if (hits.length === 0) return null;
  const agent = ctx.kb.agents.get(ctx.agentId);
  for (const hit of hits) {
    const curator = ctx.curatorOf(hit.workspaceKey);
    if (curator === null) return deny(WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER, p);
    if (curator !== ctx.agentId || agent?.workspaceKey !== hit.workspaceKey) {
      return deny(WRITE_GUARD_RULE_KB_WORKSPACE, p);
    }
  }
  return ALLOW;
}

function personalZoneVerdict(p: string, ctx: KbRuleContext, agent: KbAgentInfo | undefined) {
  const { normalizer } = ctx;
  const hits = ctx.kb.personalZones.filter((zone) => normalizer.isWithin(p, zone));
  if (hits.length === 0) return null;
  const ownZone = agent?.personalZone;
  const ownRoot = agent?.ownRoot;
  const allowed =
    ownZone !== undefined &&
    ownRoot !== undefined &&
    normalizer.isWithin(p, ownRoot) &&
    hits.every((zone) => samePath(normalizer, zone, ownZone));
  return allowed ? ALLOW : deny(WRITE_GUARD_RULE_KB_PERSONAL, p);
}

function isProtectedConfig(p: string, ctx: KbRuleContext, agent: KbAgentInfo): boolean {
  const { normalizer } = ctx;
  const { config } = ctx.kb;
  if (normalizer.isWithin(p, config.pixelAgentsDir)) return true;
  if (agent.claudeDir !== undefined && normalizer.isWithin(p, agent.claudeDir)) return true;
  if (config.settingsFiles.some((file) => samePath(normalizer, p, file))) return true;
  return (
    samePath(normalizer, path.dirname(p), config.claudeHome) &&
    KB_CLAUDE_SETTINGS_FILE_PATTERN.test(path.basename(p))
  );
}

/**
 * 一個寫入路徑的 KB 與 F17 判斷（檔案工具與 Bash 共用）：工作空間 KB 區優先，
 * 否則個人 KB 區，再套用 F17。回 null 表示放行。
 */
export function pathWriteVerdict(p: string, ctx: KbRuleContext): RuleVerdict | null {
  const agent = ctx.kb.agents.get(ctx.agentId);
  const workspace = workspaceZoneVerdict(p, ctx);
  if (workspace?.verdict === 'deny') return workspace;
  if (workspace === null) {
    const personal = personalZoneVerdict(p, ctx, agent);
    if (personal?.verdict === 'deny') return personal;
  }
  if (agent?.rulesActive && isProtectedConfig(p, ctx, agent)) {
    return deny(WRITE_GUARD_RULE_PROTECTED_CONFIG, p);
  }
  return null;
}

/**
 * P3：遞迴寫入（rm -r、mv 的來源等）的目標若是受保護區的上層，整個受保護區都會被
 * 刪除或移走。工作空間 KB 區落在其下：必須是該工作空間的 curator；個人 KB 區落在其下：
 * 一律 deny（裡面有其他識別鍵）；F17 的目錄或檔案落在其下：deny。回 null 表示放行。
 */
export function containerVerdict(p: string, ctx: KbRuleContext): RuleVerdict | null {
  const { normalizer, kb } = ctx;
  const agent = kb.agents.get(ctx.agentId);
  for (const zone of kb.workspaceZones) {
    if (!normalizer.isWithin(zone.zone, p)) continue;
    const verdict = workspaceZoneVerdict(zone.zone, ctx);
    if (verdict?.verdict === 'deny') return { ...verdict, path: p };
  }
  if (kb.personalZones.some((zone) => normalizer.isWithin(zone, p))) {
    return deny(WRITE_GUARD_RULE_KB_PERSONAL, p);
  }
  if (agent?.rulesActive) {
    const { config } = kb;
    const guarded = [config.pixelAgentsDir, config.claudeHome, ...config.settingsFiles];
    if (agent.claudeDir !== undefined) guarded.push(agent.claudeDir);
    if (guarded.some((g) => normalizer.isWithin(g, p))) {
      return deny(WRITE_GUARD_RULE_PROTECTED_CONFIG, p);
    }
  }
  return null;
}

/** 額外受保護根目錄（setProtectedRoots）的命中；P1 語意。 */
export function extraRootVerdict(paths: readonly string[], ctx: KbRuleContext): RuleVerdict | null {
  const hit = paths.find((p) => ctx.extraRoots.some((root) => ctx.normalizer.isWithin(p, root)));
  return hit === undefined ? null : deny(WRITE_GUARD_RULE_PROTECTED_PATH, hit);
}

/** P2 的規則：工作空間 KB、個人 KB、F17、F7。 */
export function kbRule(request: GuardRequest, ctx: KbRuleContext): RuleVerdict {
  const extra = extraRootVerdict(request.paths, ctx);
  if (extra !== null) return extra;
  if (!WRITE_GUARD_FILE_WRITE_TOOLS.includes(request.tool_name)) return ALLOW;

  if (request.unresolved === true && ctx.kb.anyActive) {
    return deny(WRITE_GUARD_RULE_KB_PATH_UNRESOLVED);
  }
  for (const p of request.paths) {
    const verdict = pathWriteVerdict(p, ctx);
    if (verdict !== null) return verdict;
  }
  return ALLOW;
}
