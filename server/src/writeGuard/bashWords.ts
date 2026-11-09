/**
 * Bash 斷詞：單一 word 的讀取（引號、反斜線、`$` 展開、反引號）。純函式。
 * 命令替換的內容透過注入的 lexNested 遞迴斷詞（bashLexer.ts），避免兩個模組互相匯入。
 */

import { decodeAnsiC } from './bashAnsi.js';
import type { BashToken, BashWord } from './bashTypes.js';

/** 遞迴斷詞：從 start 開始、在對應的 `)` 停止（paren 模式）或斷完整段字串。 */
export type LexNested = (
  src: string,
  start: number,
  mode: 'top' | 'paren',
) => { tokens: BashToken[]; end: number };

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAM = /[0-9@*#?$!-]/;

export function isWordBreak(ch: string): boolean {
  return WORD_BREAK.has(ch);
}

interface Piece {
  text: string;
  end: number;
  expansion: boolean;
  subs: BashToken[][];
  /** 值無法確定（例如 `$'\u'` 解碼失敗）。 */
  unresolved?: boolean;
}

/**
 * `$(( ... ))` 算術展開（i 指向 `$((` 之後）；內部的 `$(` 與反引號遞迴斷詞。
 * 與 bash 相同：對應的右括號若不是緊接著的 `))`（例如 `$((rm x) )`），這不是算術
 * 而是「命令替換裡的子殼層」，回 null 讓呼叫端改以命令替換解析（否則裡面的指令會被漏掉）。
 */
export function readArithmetic(src: string, i: number, lex: LexNested): Piece | null {
  const start = i - 3;
  const subs: BashToken[][] = [];
  let depth = 2;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '$' && src[j + 1] === '(' && src[j + 2] !== '(') {
      const nested = lex(src, j + 2, 'paren');
      subs.push(nested.tokens);
      j = nested.end + 1;
      continue;
    }
    if (ch === '`') {
      const tick = readBacktick(src, j, lex);
      subs.push(...tick.subs);
      j = tick.end;
      continue;
    }
    if (ch === ')' && depth === 2) {
      if (src[j + 1] !== ')') return null;
      return { text: src.slice(start, j + 2), end: j + 2, expansion: true, subs };
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    j++;
  }
  return { text: src.slice(start, j), end: j, expansion: true, subs };
}

/** `${ ... }`：找對應的 `}`，略過引號；內部的 `$(` 與反引號遞迴斷詞。 */
function readBraceParam(src: string, i: number, lex: LexNested): Piece {
  const start = i - 2;
  const subs: BashToken[][] = [];
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", j + 1);
      j = close < 0 ? src.length : close + 1;
      continue;
    }
    if (ch === '$' && src[j + 1] === '(') {
      const nested = lex(src, j + 2, 'paren');
      subs.push(nested.tokens);
      j = nested.end + 1;
      continue;
    }
    if (ch === '`') {
      const tick = readBacktick(src, j, lex);
      subs.push(...tick.subs);
      j = tick.end;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    j++;
  }
  return { text: src.slice(start, j), end: j, expansion: true, subs };
}

/** 反引號命令替換：內容中的 `\``、`\\`、`\$` 去跳脫後再斷詞。 */
export function readBacktick(src: string, i: number, lex: LexNested): Piece {
  let j = i + 1;
  let inner = '';
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\' && j + 1 < src.length && '`\\$'.includes(src[j + 1])) {
      inner += src[j + 1];
      j += 2;
      continue;
    }
    inner += src[j];
    j++;
  }
  const end = Math.min(j + 1, src.length);
  return { text: src.slice(i, end), end, expansion: true, subs: [lex(inner, 0, 'top').tokens] };
}

/** `$'...'`：完整解碼（bashAnsi.ts），讓字面路徑不能靠跳脫藏起來。 */
function readAnsiC(src: string, i: number): Piece {
  const { text, end, unresolved } = decodeAnsiC(src, i);
  return { text, end, expansion: false, subs: [], ...(unresolved ? { unresolved } : {}) };
}

/** `$` 開頭的展開。inDouble 為 true 時 `$'` 與 `$"` 不特別處理。 */
export function readDollar(src: string, i: number, inDouble: boolean, lex: LexNested): Piece {
  const next = src[i + 1];
  const arithmetic = next === '(' && src[i + 2] === '(' ? readArithmetic(src, i + 3, lex) : null;
  if (arithmetic !== null) return arithmetic;
  if (next === '(') {
    const nested = lex(src, i + 2, 'paren');
    const end = Math.min(nested.end + 1, src.length);
    return { text: src.slice(i, end), end, expansion: true, subs: [nested.tokens] };
  }
  if (next === '{') return readBraceParam(src, i + 2, lex);
  if (!inDouble && next === "'") return readAnsiC(src, i);
  if (!inDouble && next === '"') return readDoubleQuoted(src, i + 1, lex);
  if (next !== undefined && SPECIAL_PARAM.test(next) && !/[A-Za-z_]/.test(next)) {
    return { text: src.slice(i, i + 2), end: i + 2, expansion: true, subs: [] };
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let j = i + 1;
    while (j < src.length && NAME_CHAR.test(src[j])) j++;
    return { text: src.slice(i, j), end: j, expansion: true, subs: [] };
  }
  return { text: '$', end: i + 1, expansion: false, subs: [] };
}

/** 雙引號字串（i 指向開頭的 `"`）。 */
export function readDoubleQuoted(src: string, i: number, lex: LexNested): Piece {
  let j = i + 1;
  let text = '';
  let expansion = false;
  const subs: BashToken[][] = [];
  while (j < src.length && src[j] !== '"') {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) {
      const next = src[j + 1];
      if (next === '\n') {
        j += 2;
        continue;
      }
      text += '$`"\\'.includes(next) ? next : `\\${next}`;
      j += 2;
      continue;
    }
    if (ch === '$' || ch === '`') {
      const piece = ch === '$' ? readDollar(src, j, true, lex) : readBacktick(src, j, lex);
      text += piece.text;
      expansion ||= piece.expansion;
      subs.push(...piece.subs);
      j = piece.end;
      continue;
    }
    text += ch;
    j++;
  }
  return { text, end: Math.min(j + 1, src.length), expansion, subs };
}

/** 讀一個 word（i 指向第一個字元，且它不是 word 分隔字元）。 */
export function readWord(src: string, i: number, lex: LexNested): { word: BashWord; end: number } {
  const word: BashWord = {
    text: '',
    quoted: false,
    expansion: false,
    tilde: false,
    assignment: ASSIGNMENT_PREFIX.test(src.slice(i, i + 256)),
    substitutions: [],
  };
  if (src[i] === '~') {
    // `~`、`~/`：HOME；`~+`：目前目錄；`~-`、`~N`、`~+N`、`~-N`：目錄堆疊（無法精確追蹤）；
    // `~user`：其他使用者的 HOME（無法解析）。只有 `~` 與 `~/` 設 tilde（第二次驗證 P2-3）。
    const prefix = /^~([^/\s;&|()<>'"`$]*)/.exec(src.slice(i, i + 256))?.[1] ?? '';
    if (prefix === '') word.tilde = true;
    else {
      word.expansion = true;
      word.tildeKind = prefix === '+' ? 'plus' : /^[+-]?\d*$/.test(prefix) ? 'minus' : 'user';
    }
  }
  let j = i;
  let openBracket = false;
  while (j < src.length && !isWordBreak(src[j])) {
    const ch = src[j];
    if (ch === '\\') {
      if (src[j + 1] !== '\n' && j + 1 < src.length) {
        word.text += src[j + 1];
        word.quoted = true;
      }
      j += 2;
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", j + 1);
      const end = close < 0 ? src.length : close;
      word.text += src.slice(j + 1, end);
      word.quoted = true;
      j = end + 1;
      continue;
    }
    if (ch === '"' || ch === '$' || ch === '`') {
      const piece =
        ch === '"'
          ? readDoubleQuoted(src, j, lex)
          : ch === '$'
            ? readDollar(src, j, false, lex)
            : readBacktick(src, j, lex);
      word.text += piece.text;
      word.quoted ||= ch === '"' || (ch === '$' && /['"]/.test(src[j + 1] ?? ''));
      word.expansion ||= piece.expansion;
      if (piece.unresolved) word.unresolved = true;
      word.substitutions.push(...piece.subs);
      j = piece.end;
      continue;
    }
    // glob：`*`、`?`，以及配對的 `[...]`（單獨的 `[`、`[[` 不是 glob，否則 `[ -f x ]` 與
    // `[[ ... ]]` 會被當成指令名稱含展開而無法分類）。
    if (ch === '*' || ch === '?' || (ch === ']' && openBracket)) word.expansion = true;
    if (ch === '[') openBracket = true;
    word.text += ch;
    j++;
  }
  return { word, end: Math.max(j, i + 1) };
}
