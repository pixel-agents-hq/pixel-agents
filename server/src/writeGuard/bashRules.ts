/**
 * Bash 的伺服器端規則（P3 補充決定 4、5）。只讀記憶體（F13）：指令以純函式再解析一次
 * （角色分類，與以 Agent Directory 為起點的字面候選），hook 送來的路徑已正規化。
 *
 * 依序判斷，第一個 deny 即為結果（deny 優先）：
 * 1. 額外受保護根目錄（setProtectedRoots，測試用）。
 * 2. 寫入目標無法判斷且任一工作空間有根目錄：deny。
 * 3. 每個寫入目標、字面路徑片段：P2 的 KB 規則與 F17（pathWriteVerdict）；遞迴目標
 *    另外檢查受保護區是否落在其下（containerVerdict）。不論有無角色都套用。
 * 4. 權限角色：缺少所需的操作類別即 deny（沒設角色時不檢查）。curator 對工作空間 KB
 *    的例外只放寬第 3 步，不放寬這一步（F11）。
 */

import {
  WRITE_GUARD_BASH_MAX_PARSE_BYTES,
  WRITE_GUARD_RULE_BASH_UNRESOLVED,
} from '../constants.js';
import { analyzeBash } from './bashAnalysis.js';
import { literalZonePaths } from './bashLiteralScan.js';
import { lexicalBashPaths } from './bashPaths.js';
import type { BashAnalysis, GuardOperation } from './bashTypes.js';
import type { KbRuleContext, RuleVerdict } from './kbRules.js';
import { containerVerdict, extraRootVerdict, pathWriteVerdict } from './kbRules.js';
import { platformFor } from './pathNormalization.js';
import { missingOperation, RULE_OF_OPERATION } from './permissionRoles.js';
import type { GuardRequest } from './protocol.js';

const ALLOW: RuleVerdict = { verdict: 'allow' };

/** 指令可解析時回分析結果；指令沒送或超過上限時回 null（無法分類、目標無法判斷）。 */
export function analyzeRequestCommand(
  request: GuardRequest,
  platform: NodeJS.Platform = process.platform,
): BashAnalysis | null {
  const { command } = request;
  if (command === undefined) return null;
  if (Buffer.byteLength(command) > WRITE_GUARD_BASH_MAX_PARSE_BYTES) return null;
  return analyzeBash(command, { platform });
}

/** 沒有可解析的指令時的操作類別：hook 端解析結果，否則視為無法分類（需要 edit）。 */
function operationsOf(request: GuardRequest, analysis: BashAnalysis | null): GuardOperation[] {
  if (analysis !== null) return analysis.ops;
  // 沒有可解析的指令（超過 1 MiB、沒送 command）：與巢狀超限相同，需要 edit 與 delete
  // （第二次驗證 P4：不能用填充夾帶 rm）；請求帶 hook 端解析結果時以它為準。
  return request.bash_ops ?? ['edit', 'delete'];
}

/**
 * 永不拋出（驗證 F-1）：任何例外視為無法解析——KB 規則啟用時 deny；否則需要 read、edit、
 * delete 三種角色（沒設角色時放行，與「沒設角色等於全開」一致）。
 */
export function bashRule(request: GuardRequest, ctx: KbRuleContext): RuleVerdict {
  try {
    return bashRuleUnsafe(request, ctx);
  } catch {
    if (ctx.kb.anyActive) return { verdict: 'deny', rule: WRITE_GUARD_RULE_BASH_UNRESOLVED };
    const roles = ctx.kb.agents.get(ctx.agentId)?.roles ?? null;
    const missing = missingOperation(roles, ['read', 'edit', 'delete']);
    return missing === null ? ALLOW : { verdict: 'deny', rule: RULE_OF_OPERATION[missing] };
  }
}

/** 伺服器端的「子字串包含」掃描對象：兩種 KB 區、額外根目錄與 F17 的目錄。 */
function literalZones(ctx: KbRuleContext): string[] {
  const { kb } = ctx;
  const claudeDir = kb.agents.get(ctx.agentId)?.claudeDir;
  return [
    ...ctx.extraRoots,
    ...kb.workspaceZones.map((z) => z.zone),
    ...kb.personalZones,
    kb.config.pixelAgentsDir,
    kb.config.claudeHome,
    ...(claudeDir !== undefined ? [claudeDir] : []),
  ];
}

function bashRuleUnsafe(request: GuardRequest, ctx: KbRuleContext): RuleVerdict {
  const analysis = analyzeRequestCommand(request, platformFor(ctx.normalizer));
  const agent = ctx.kb.agents.get(ctx.agentId);
  const lexical =
    analysis !== null && agent?.directory !== undefined
      ? lexicalBashPaths(analysis, agent.directory, ctx.kb.homeDir)
      : { direct: [], recursive: [], mentioned: [] };
  const direct = [...request.paths, ...lexical.direct];
  const recursive = [...(request.recursive_paths ?? []), ...lexical.recursive];
  // 根目錄含空白等情況下片段切分會失效：文字「包含」受保護區根目錄也算字面命中（P2-4）。
  const literal = analysis
    ? literalZonePaths(analysis.literalTexts, literalZones(ctx), ctx.normalizer)
    : [];
  const mentioned = [...(request.mentioned_paths ?? []), ...lexical.mentioned, ...literal];

  const extra = extraRootVerdict([...direct, ...recursive, ...mentioned], ctx);
  if (extra !== null) return extra;

  const unresolved = request.unresolved === true || analysis === null || analysis.truncated;
  if (unresolved && ctx.kb.anyActive)
    return { verdict: 'deny', rule: WRITE_GUARD_RULE_BASH_UNRESOLVED };

  for (const p of [...direct, ...mentioned]) {
    const verdict = pathWriteVerdict(p, ctx);
    if (verdict !== null) return verdict;
  }
  for (const p of recursive) {
    const verdict = pathWriteVerdict(p, ctx) ?? containerVerdict(p, ctx);
    if (verdict !== null) return verdict;
  }

  const missing = missingOperation(agent?.roles ?? null, operationsOf(request, analysis));
  if (missing === null) return ALLOW;
  const fragment = analysis?.opSources[missing];
  return {
    verdict: 'deny',
    rule: RULE_OF_OPERATION[missing],
    ...(fragment !== undefined ? { fragment } : {}),
  };
}
