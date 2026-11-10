/**
 * 伺服器端的完整裁決規則（P3）：WriteGuard 的預設規則。只讀記憶體（F13）。
 *
 * - Bash：bashRules.ts（KB、F17、角色，含 Bash 解析）。
 * - 其他工具：P2 的 kbRule（KB、F17、F7），再判斷權限角色（Read、Glob、Grep 需要 R；
 *   Write、Edit、NotebookEdit 需要 E）。deny 優先：KB 拒絕時不再看角色；KB 放行（例如
 *   curator 寫工作空間 KB）不代表角色放行（F11）。沒設角色的 Agent 與 P2 完全相同。
 */

import { WRITE_GUARD_BASH_TOOL } from '../constants.js';
import { bashRule } from './bashRules.js';
import type { KbRuleContext, RuleVerdict } from './kbRules.js';
import { kbRule } from './kbRules.js';
import { missingOperation, RULE_OF_OPERATION, toolOperations } from './permissionRoles.js';
import type { GuardRequest } from './protocol.js';

export function guardRule(request: GuardRequest, ctx: KbRuleContext): RuleVerdict {
  if (request.tool_name === WRITE_GUARD_BASH_TOOL) return bashRule(request, ctx);
  const kb = kbRule(request, ctx);
  if (kb.verdict === 'deny') return kb;
  const roles = ctx.kb.agents.get(ctx.agentId)?.roles ?? null;
  const missing = missingOperation(roles, toolOperations(request.tool_name));
  if (missing === null) return kb;
  const firstPath = request.paths[0];
  return firstPath === undefined
    ? { verdict: 'deny', rule: RULE_OF_OPERATION[missing] }
    : { verdict: 'deny', rule: RULE_OF_OPERATION[missing], path: firstPath };
}
