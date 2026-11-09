/**
 * Bash 保留字（P3）。lexer 判斷「指令開頭」與 parser 略過保留字共用同一份清單。
 * 保留字只在未加引號且位於指令開頭時才是保留字（bash 的語意）。
 */

import type { BashWord } from './bashTypes.js';

/** 指令開頭時直接略過、其後仍是一個指令的保留字。 */
export const TRANSPARENT_KEYWORDS: ReadonlySet<string> = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'esac',
  'time',
  'coproc',
  // zsh：`{ ... } always { ... }` 的 always、`foreach ... end` 的 end（兩個區塊都照常分析）。
  'always',
  'end',
]);

/** 標頭不是指令的保留字（`for x in ...`、`select x in ...`）。 */
export const HEADER_KEYWORDS: ReadonlySet<string> = new Set(['for', 'select', 'foreach']);

/** lexer 插入的 null 指令（`:`，讀取類）：case 的主詞與樣式成為它的參數，
 *  其中的命令替換仍會被解析，但樣式本身不會被當成指令名稱。 */
export function nullCommandWord(): BashWord {
  return {
    text: ':',
    quoted: false,
    expansion: false,
    tilde: false,
    assignment: false,
    substitutions: [],
  };
}

/** 未加引號的保留字比對。 */
export function isKeyword(word: BashWord, keyword: string): boolean {
  return !word.quoted && word.text === keyword;
}
