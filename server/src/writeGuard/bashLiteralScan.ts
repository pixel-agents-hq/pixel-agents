/**
 * 「子字串包含受保護區根目錄」的掃描（P3，第二次驗證 P2-4）。hook 端與伺服器端共用。
 *
 * 片段切分會在空白、引號等字元切斷路徑，根目錄含空白（`/T/my proj/.note`）時整個失效。
 * 這裡另外對每個受保護區根目錄，檢查非讀取類指令的解碼後文字是否「包含」它：
 * - 兩邊都以 literalComparisonKey 折疊（大小寫、NFC、win32 分隔字元），根目錄去掉結尾分隔字元；
 * - 命中處之後必須是結尾、分隔字元或非檔名字元（`/w/.notes` 不算命中 `/w/.note`）；命中處
 *   之前不限制（`-o/w/.note/x` 這種黏著值也要命中；代價是 `/x/w/.note` 這種更長路徑的
 *   後綴也會命中，屬保守的誤拒絕）；
 * - 回傳從命中處到第一個引號、換行、`;|&<>()$` 之間的文字（去掉結尾空白）作為候選路徑，
 *   交給呼叫端套用一般的 KB／F17 規則（curator、自己的識別鍵照常放行）。
 * 候選是折疊後的字串；比對規則（isWithin）本身也折疊，因此結果一致。純函式。
 */

import type { PathNormalizer } from './pathNormalization.js';
import { literalComparisonKey } from './pathNormalization.js';

/** 一次掃描最多回傳的候選數（超過的不再收集；呼叫端已經會因為前面的命中而 deny）。 */
const MAX_CANDIDATES = 64;
const NAME_CHAR = /[\p{L}\p{N}._~-]/u;
const CANDIDATE_END = /['"`\n\r\t;|&<>()$]/;

export function literalZonePaths(
  texts: readonly string[],
  zones: readonly string[],
  normalizer: PathNormalizer,
): string[] {
  const keys = zones
    .map((zone) => literalComparisonKey(normalizer, zone).replace(/[\\/]+$/, ''))
    .filter((key) => key.length > 1);
  const out: string[] = [];
  for (const text of texts) {
    const folded = literalComparisonKey(normalizer, text);
    for (const key of keys) {
      let from = 0;
      for (;;) {
        const at = folded.indexOf(key, from);
        if (at < 0) break;
        from = at + 1;
        const after = folded[at + key.length];
        if (after !== undefined && NAME_CHAR.test(after)) continue;
        let end = at + key.length;
        while (end < folded.length && !CANDIDATE_END.test(folded[end])) end++;
        out.push(folded.slice(at, end).replace(/\s+$/, ''));
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
  }
  return out;
}
