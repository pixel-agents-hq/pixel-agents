/**
 * heredoc 本文的讀取（P3）。本文是資料，不是指令；但無引號分隔字的本文中，
 * 命令替換會執行，因此遞迴斷詞。本文原文也保留下來（驗證 F-4：承接者不是讀取類時，
 * 例如 `python3 - <<'EOF'`，本文就是程式，要掃描其中的字面路徑）。純函式。
 */

import type { BashToken } from './bashTypes.js';
import type { LexNested } from './bashWords.js';
import { readBacktick, readDollar } from './bashWords.js';

export interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  token: Extract<BashToken, { kind: 'redirect' }>;
}

/** 無引號 heredoc 本文中的命令替換（本文其餘部分是資料）。 */
function heredocSubstitutions(body: string, lex: LexNested): BashToken[][] {
  const subs: BashToken[][] = [];
  let j = 0;
  while (j < body.length) {
    if (body[j] === '\\') {
      j += 2;
    } else if (body[j] === '$' || body[j] === '`') {
      const piece = body[j] === '$' ? readDollar(body, j, true, lex) : readBacktick(body, j, lex);
      subs.push(...piece.subs);
      j = Math.max(piece.end, j + 1);
    } else {
      j++;
    }
  }
  return subs;
}

/** 從 i（換行之後）讀掉所有待處理的 heredoc 本文，回傳本文之後的位置。 */
export function consumeHeredocs(
  src: string,
  i: number,
  pending: PendingHeredoc[],
  lex: LexNested,
): number {
  let j = i;
  for (const doc of pending.splice(0)) {
    const lines: string[] = [];
    while (j <= src.length) {
      const newline = src.indexOf('\n', j);
      const lineEnd = newline < 0 ? src.length : newline;
      const line = src.slice(j, lineEnd);
      j = lineEnd + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
      lines.push(line);
      if (newline < 0) break;
    }
    const body = lines.join('\n');
    doc.token.heredocBody = body;
    if (!doc.quoted) doc.token.heredocSubstitutions = heredocSubstitutions(body, lex);
  }
  return j;
}
