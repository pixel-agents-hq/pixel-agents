/**
 * 拒絕訊息的固定範本（F16）。
 *
 * 訊息由 hook 端組出，而不是轉送伺服器的文字：伺服器只回規則識別碼與路徑，
 * hook 依識別碼套用 constants.ts 的固定範本，且只在該路徑確實是這次請求
 * 自己送出的路徑時才把它放進訊息。因此訊息裡不可能出現 curator 身分、
 * 其他 Agent 的路徑或任何可命名的字串。
 */

import {
  WRITE_GUARD_DENY_GENERIC,
  WRITE_GUARD_DENY_PATH_MAX_LENGTH,
  WRITE_GUARD_DENY_TEMPLATES,
} from '../constants.js';

/** 只保留可列印字元並限制長度；JSON 字面量包起來，換行等字元不會改變訊息結構。 */
function quotePath(value: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, '');
  const clipped =
    printable.length > WRITE_GUARD_DENY_PATH_MAX_LENGTH
      ? `${printable.slice(0, WRITE_GUARD_DENY_PATH_MAX_LENGTH)}...`
      : printable;
  return JSON.stringify(clipped);
}

/**
 * 組出拒絕訊息：原因、理由、建議三段。
 * @param rule 規則識別碼；未知者套用通用範本。
 * @param path 觸發規則的路徑；不在 ownPaths 內就不放進訊息。
 * @param ownPaths 這次請求自己送出的路徑。
 */
export function renderDenyMessage(
  rule: string,
  path: string | undefined,
  ownPaths: readonly string[],
): string {
  const template = Object.prototype.hasOwnProperty.call(WRITE_GUARD_DENY_TEMPLATES, rule)
    ? WRITE_GUARD_DENY_TEMPLATES[rule]
    : WRITE_GUARD_DENY_GENERIC;
  const pathLine =
    path !== undefined && ownPaths.includes(path) ? ` Path: ${quotePath(path)}.` : '';
  return [
    `Reason: ${template.reason}${pathLine}`,
    `Why: ${template.rationale}`,
    `Suggestion: ${template.suggestion}`,
  ].join('\n');
}
