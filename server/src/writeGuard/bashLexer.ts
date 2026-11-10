/**
 * Bash 斷詞器（P3，F10）：把指令字串切成 word、運算子與重導向。純函式。
 *
 * 涵蓋：`;`、`&&`、`||`、`|`、`|&`、`&`、換行、`(`、`)`；`>`、`>>`、`>|`、`&>`、`&>>`、
 * `N>`、`<`、`<>`、`>&`、`<&`、heredoc（`<<`、`<<-`，本文不當成指令）、herestring；
 * 單雙引號、反斜線跳脫、行接續、註解；`$( )`、反引號、`<( )`、`>( )` 遞迴斷詞；
 * `case ... esac` 的樣式 `)` 不當成括號（bashCase.ts）。
 * 不做任何展開（變數、glob、brace），值照字面保留並標記 expansion。
 */

import { WRITE_GUARD_BASH_MAX_NESTING } from '../constants.js';
import type { WorkBudget } from './bashBudget.js';
import { WorkBudget as Budget } from './bashBudget.js';
import { CaseTracker } from './bashCase.js';
import type { PendingHeredoc } from './bashHeredoc.js';
import { consumeHeredocs } from './bashHeredoc.js';
import { nullCommandWord, TRANSPARENT_KEYWORDS } from './bashKeywords.js';
import type { BashToken, LexResult, RedirectKind } from './bashTypes.js';
import type { LexNested } from './bashWords.js';
import { readArithmetic, readWord } from './bashWords.js';

interface LexState {
  nestingExceeded: boolean;
  budget: WorkBudget;
}

/** 依序比對的重導向運算子（長的在前）。 */
const REDIRECTS: readonly [string, RedirectKind][] = [
  ['&>>', 'write'],
  ['&>', 'write'],
  ['<<<', 'herestring'],
  ['<<-', 'heredoc'],
  ['<<', 'heredoc'],
  ['<>', 'readWrite'],
  ['<&', 'dupOrRead'],
  ['<', 'read'],
  // zsh 的 clobber 形式 `>!`、`>>!`、`&>!`（等同 `>|`）：目標是下一個 word。
  ['&>>!', 'write'],
  ['&>!', 'write'],
  ['>>!', 'write'],
  ['>>|', 'write'],
  ['>!', 'write'],
  ['>>', 'write'],
  ['>|', 'write'],
  ['>&', 'dupOrWrite'],
  ['>', 'write'],
];

/** 運算子原文與其 token（`;;` 等 case 結尾在 case 之外等同 `;`）。 */
const OPERATORS: readonly [string, BashToken][] = [
  [';;&', { kind: 'op', op: ';' }],
  [';;', { kind: 'op', op: ';' }],
  [';&', { kind: 'op', op: ';' }],
  [';', { kind: 'op', op: ';' }],
  ['&&', { kind: 'op', op: '&&' }],
  ['&', { kind: 'op', op: '&' }],
  ['||', { kind: 'op', op: '||' }],
  ['|&', { kind: 'op', op: '|' }],
  ['|', { kind: 'op', op: '|' }],
];

function plainWord(text: string, substitutions: BashToken[][] = [], expansion = false): BashToken {
  return {
    kind: 'word',
    word: { text, quoted: false, expansion, tilde: false, assignment: false, substitutions },
  };
}

const isWordToken = (token: BashToken | undefined, text: string): boolean =>
  token?.kind === 'word' && !token.word.quoted && token.word.text === text;

/** 下一個 word 是否位於指令開頭（保留字只在這裡才是保留字）。 */
function atCommandStart(tokens: readonly BashToken[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last === undefined || last.kind === 'op') return true;
  return last.kind === 'word' && !last.word.quoted && TRANSPARENT_KEYWORDS.has(last.word.text);
}

function lexAt(
  src: string,
  start: number,
  mode: 'top' | 'paren',
  depth: number,
  state: LexState,
): { tokens: BashToken[]; end: number } {
  if (depth > WRITE_GUARD_BASH_MAX_NESTING) {
    state.nestingExceeded = true;
    return { tokens: [], end: src.length };
  }
  const lex: LexNested = (s, at, m) => lexAt(s, at, m, depth + 1, state);
  const tokens: BashToken[] = [];
  const pending: PendingHeredoc[] = [];
  const cases = new CaseTracker();
  // `[[ ... ]]` 內 `<`、`>`、`&&`、`||`、`(`、`)` 是比較與邏輯運算子；`let` 的參數中 `<<`
  // 是位移運算子：兩者都不是重導向或 heredoc（第二次驗證 P2-5，否則 heredoc 會吞掉後續行）。
  let inTest = false;
  let inLet = false;
  const done = (end: number) => {
    // case 沒有配對到 esac：無法保證斷詞正確，視為無法解析（保守）。
    if (cases.open) state.nestingExceeded = true;
    return { tokens, end };
  };
  let parens = 0;
  let i = start;
  let atWordStart = true;
  while (i < src.length) {
    state.budget.spend();
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      atWordStart = true;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '#' && atWordStart) {
      const newline = src.indexOf('\n', i);
      i = newline < 0 ? src.length : newline;
      continue;
    }
    if (ch === '\n') {
      inTest = false;
      inLet = false;
      tokens.push(...(cases.onNewline() ?? [{ kind: 'op', op: ';' }]));
      i = consumeHeredocs(src, i + 1, pending, lex);
      atWordStart = true;
      continue;
    }
    // `(( expr ))` 算術指令（指令開頭或 `for` 之後）：配對到緊接的 `))` 才是算術，否則照 bash
    // 的規則當成巢狀子殼層。算術內容不斷詞（`<<` 是位移），其中的 `$( )`、反引號仍解析。
    const last = tokens[tokens.length - 1];
    const arithmeticHere = atCommandStart(tokens) || isWordToken(last, 'for');
    if (ch === '(' && src[i + 1] === '(' && arithmeticHere && !cases.inPattern) {
      const piece = readArithmetic(src, i + 2, lex);
      if (piece !== null) {
        // 內容本身又以 `(` 開頭（`((((rm x))))`）時無法確定是算術還是巢狀子殼層：兩種解讀
        // 都分析（deny 優先）。子殼層解讀只斷詞這段子字串，其中的 heredoc 吞不到外面的行。
        const inner = src.slice(i + 2, Math.max(i + 2, piece.end - 2));
        const both = inner.trimStart().startsWith('(');
        const subs = both ? [...piece.subs, lex(inner, 0, 'top').tokens] : piece.subs;
        tokens.push({ kind: 'word', word: nullCommandWord() });
        tokens.push(plainWord(src.slice(i, piece.end), subs, true));
        i = Math.max(piece.end, i + 2);
        atWordStart = true;
        continue;
      }
    }
    if (inTest && /[<>&|()!]/.test(ch)) {
      let j = i;
      while (j < src.length && /[<>&|()!]/.test(src[j])) j++;
      tokens.push(plainWord(src.slice(i, j)));
      i = j;
      atWordStart = true;
      continue;
    }
    if (ch === '(' || ch === ')') {
      const replaced = ch === ')' ? cases.onCloseParen() : cases.onOpenParen();
      if (replaced !== null) {
        tokens.push(...replaced);
        i++;
        atWordStart = true;
        continue;
      }
      if (ch === ')' && mode === 'paren' && parens === 0) return done(i);
      parens += ch === '(' ? 1 : -1;
      tokens.push({ kind: 'op', op: ch });
      i++;
      atWordStart = true;
      continue;
    }
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      // 程序替換：內容是會執行的指令；word 本身是展開（值在執行期才知道）。
      const nested = lex(src, i + 2, 'paren');
      tokens.push({
        kind: 'word',
        word: {
          text: src.slice(i, nested.end + 1),
          quoted: false,
          expansion: true,
          tilde: false,
          assignment: false,
          substitutions: [nested.tokens],
        },
      });
      i = nested.end + 1;
      continue;
    }
    const fd = /^\d+(?=[<>])/.exec(src.slice(i, i + 12));
    const at = fd ? i + fd[0].length : i;
    const redirect = REDIRECTS.find(([text]) => src.startsWith(text, at));
    if (redirect && redirect[1] === 'heredoc' && inLet) {
      tokens.push(plainWord(redirect[0]));
      i = at + redirect[0].length;
      atWordStart = true;
      continue;
    }
    if (redirect) {
      state.budget.spend(redirect[0].length);
      const token: Extract<BashToken, { kind: 'redirect' }> = {
        kind: 'redirect',
        redirect: redirect[1],
      };
      tokens.push(token);
      i = at + redirect[0].length;
      if (redirect[1] === 'heredoc') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        if (i < src.length) {
          const delimiter = readWord(src, i, lex);
          pending.push({
            delimiter: delimiter.word.text,
            quoted: delimiter.word.quoted,
            stripTabs: redirect[0] === '<<-',
            token,
          });
          i = delimiter.end;
        }
      }
      atWordStart = true;
      continue;
    }
    const operator = OPERATORS.find(([text]) => src.startsWith(text, i));
    if (operator) {
      state.budget.spend(operator[0].length);
      inLet = false;
      if (operator[0].startsWith(';')) inTest = false;
      tokens.push(...(cases.onOperator(operator[0]) ?? [operator[1]]));
      i += operator[0].length;
      atWordStart = true;
      continue;
    }
    const { word, end } = readWord(src, i, lex);
    state.budget.spend(end - i);
    const commandStart = atCommandStart(tokens);
    if (commandStart && !word.quoted && word.text === '[[') inTest = true;
    if (commandStart && !word.quoted && word.text === 'let') inLet = true;
    if (inTest && !word.quoted && word.text === ']]') inTest = false;
    tokens.push(...cases.onWord(word, commandStart));
    i = end;
    atWordStart = false;
  }
  return done(src.length);
}

/** 斷詞一整段指令字串。 */
export function lexBash(src: string, budget: WorkBudget = new Budget()): LexResult {
  const state: LexState = { nestingExceeded: false, budget };
  const { tokens, end } = lexAt(src, 0, 'top', 0, state);
  return { tokens, end, nestingExceeded: state.nestingExceeded };
}
