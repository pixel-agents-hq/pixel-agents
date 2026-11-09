/**
 * P3 的拒絕訊息（F16）：P1 的固定範本（denyMessage.ts），加上觸發規則的指令名稱片段。
 *
 * 片段只在它確實是這次指令中某個簡單指令的名稱時才放進訊息（hook 以自己的解析結果
 * 比對），並去除控制字元、限制長度、以 JSON 字面量包起來。訊息從不包含整段 command。
 */

import { WRITE_GUARD_DENY_FRAGMENT_MAX_LENGTH } from '../constants.js';
import { renderDenyMessage } from './denyMessage.js';

function quoteFragment(value: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, '');
  const clipped =
    printable.length > WRITE_GUARD_DENY_FRAGMENT_MAX_LENGTH
      ? `${printable.slice(0, WRITE_GUARD_DENY_FRAGMENT_MAX_LENGTH)}...`
      : printable;
  return JSON.stringify(clipped);
}

/**
 * @param fragment 伺服器回的指令名稱片段；不在 ownFragments 內就不放進訊息。
 * @param ownFragments 這次指令自己的指令名稱（hook 端解析結果）。
 */
export function renderGuardDenyMessage(
  rule: string,
  path: string | undefined,
  fragment: string | undefined,
  ownPaths: readonly string[],
  ownFragments: readonly string[],
): string {
  const message = renderDenyMessage(rule, path, ownPaths);
  if (fragment === undefined || !ownFragments.includes(fragment)) return message;
  const [first, ...rest] = message.split('\n');
  return [`${first} Command: ${quoteFragment(fragment)}.`, ...rest].join('\n');
}
