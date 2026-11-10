/**
 * 字面路徑片段的抽取（P3）。純函式、線性時間（第二次驗證 P1-1：不為每個前綴產生子字串）。
 */

import type { BashWord, PathSegment } from './bashTypes.js';

/** 程式碼與參數中路徑片段的分隔字元（引號、括號、逗號、等號、空白等）。 */
const FRAGMENT_SEPARATORS = /[\s'"`(),;=<>|&{}[\]:]+/;

/**
 * 以單破折號開頭的 word（`-o/w/.note/x`、`-C.note/k`、`-xf.note/a.tar`、`-o=/x`）：短選項的值
 * 可以黏在旗標後面（驗證 F-5）。只回傳至多三個候選：去掉 `-X` 後、去掉整段旗標字母後、
 * 第一個 `=` 之後。
 */
function attachedValues(text: string): string[] {
  if (!/^-[A-Za-z0-9]/.test(text)) return [];
  const out = new Set<string>();
  out.add(text.slice(2));
  const letters = /^-[A-Za-z0-9]+/.exec(text)?.[0].length ?? 2;
  out.add(text.slice(letters));
  const eq = text.indexOf('=');
  if (eq > 0) out.add(text.slice(eq + 1));
  out.delete('');
  return [...out];
}

function isPathFragment(f: string): boolean {
  if (f.length === 0 || f === '.' || f === '..') return false;
  return f.includes('/') || f.startsWith('.') || f.startsWith('~');
}

/** 一段文字裡看起來像路徑的片段：含 `/`，或以 `.`、`~` 開頭（`.`、`..` 本身除外）。 */
export function fragmentsOfText(
  texts: readonly string[],
  spend: (n: number) => void,
): PathSegment[] {
  const seen = new Set<string>();
  const out: PathSegment[] = [];
  for (const text of texts) {
    spend(text.length);
    for (const f of text.split(FRAGMENT_SEPARATORS)) {
      if (!isPathFragment(f) || seen.has(f)) continue;
      seen.add(f);
      out.push({ text: f, tilde: f === '~' || f.startsWith('~/') });
    }
  }
  return out;
}

/** 一個 word 的路徑片段（含短選項黏著值的候選）。 */
export function pathFragments(
  word: BashWord,
  spend: (n: number) => void = () => {},
): PathSegment[] {
  return fragmentsOfText([word.text, ...attachedValues(word.text)], spend);
}
