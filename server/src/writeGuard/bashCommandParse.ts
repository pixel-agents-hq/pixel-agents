/**
 * 一個簡單指令（或子殼層）的結構解析（P3）。純函式；由 bashParser.ts 的 parseList 呼叫，
 * 子殼層與命令替換再遞迴回 parseList（以參數注入，避免循環匯入）。
 *
 * - 保留字（if、then、do、`{`、`!`、time 及其選項、coproc 及其名稱）在指令開頭略過；
 * - `function f { ...; }`、`function f() ( ... )`：略過關鍵字與名稱，本體照常解析；
 * - `for`／`select` 的標頭不是指令，其中的命令替換仍會解析；
 * - 巢狀（子殼層、命令替換）超過 WRITE_GUARD_BASH_MAX_NESTING：標記無法解析並停止。
 */

import { WRITE_GUARD_BASH_MAX_NESTING } from '../constants.js';
import type { WorkBudget } from './bashBudget.js';
import { HEADER_KEYWORDS, TRANSPARENT_KEYWORDS } from './bashKeywords.js';
import type { BashToken, BashWord, SimpleCommand } from './bashTypes.js';

export type Dirs = BashWord[][];

export interface ParseState {
  commands: SimpleCommand[];
  dirsTruncated: boolean;
  nestingExceeded: boolean;
  /** 到目前為止出現過的所有工作目錄候選（無法精確追蹤的 cd 之後一律用它，保守）。 */
  seen: Dirs;
  budget: WorkBudget;
}

export type ParseList = (
  tokens: BashToken[],
  start: number,
  dirs: Dirs,
  state: ParseState,
  untilParen: boolean,
  depth: number,
) => { end: number; dirs: Dirs };

/** cd 的效果：精確（參數為字面目錄）或無法精確追蹤（`cd -`、popd、含展開的參數）。 */
export type CdEffect = { precise: BashWord } | 'imprecise';

export const isOp = (token: BashToken | undefined, ...ops: string[]): boolean =>
  token?.kind === 'op' && ops.includes(token.op);
const keywordText = (token: BashToken | undefined): string | undefined =>
  token?.kind === 'word' && !token.word.quoted ? token.word.text : undefined;

const HOME_WORD: BashWord = {
  text: '~',
  quoted: false,
  expansion: false,
  tilde: true,
  assignment: false,
  substitutions: [],
};

/** cd、pushd、popd（可前置 builtin、command）的效果；不是目錄變動時回 undefined。
 *  指令名稱比對去引號、去跳脫後的文字（`\cd`、`'cd'` 都是 cd）。 */
export function cdEffectOf(words: readonly BashWord[]): CdEffect | undefined {
  let i = 0;
  while (words[i] && !words[i].expansion && ['builtin', 'command'].includes(words[i].text)) {
    i++;
    while (words[i] && words[i].text === '-p') i++;
  }
  const name = words[i];
  if (!name || name.expansion) return undefined;
  if (name.text === 'popd') return 'imprecise';
  if (name.text !== 'cd' && name.text !== 'pushd') return undefined;
  const args = words.slice(i + 1).filter((w) => !/^-[LPe@]+$/.test(w.text) && w.text !== '--');
  const target = args[0];
  if (target === undefined) return name.text === 'cd' ? { precise: HOME_WORD } : 'imprecise';
  if (target.expansion || /^[-+]/.test(target.text)) return 'imprecise';
  return { precise: target };
}

function parseSubstitutions(
  words: readonly BashWord[],
  dirs: Dirs,
  state: ParseState,
  depth: number,
  parseList: ParseList,
): void {
  for (const word of words) {
    for (const tokens of word.substitutions) parseList(tokens, 0, dirs, state, false, depth + 1);
  }
}

/** 讀一個重導向（i 指向重導向 token），回傳下一個位置。 */
export function readRedirect(tokens: BashToken[], i: number, command: SimpleCommand): number {
  const token = tokens[i] as Extract<BashToken, { kind: 'redirect' }>;
  if (token.redirect === 'heredoc') {
    command.redirects.push({ kind: 'heredoc', body: token.heredocBody ?? '' });
    for (const sub of token.heredocSubstitutions ?? []) {
      command.redirects.push({
        kind: 'heredoc',
        target: { ...HOME_WORD, text: '', tilde: false, expansion: true, substitutions: [sub] },
      });
    }
    return i + 1;
  }
  const next = tokens[i + 1];
  if (next?.kind !== 'word') {
    command.redirects.push({ kind: token.redirect });
    return i + 1;
  }
  command.redirects.push({ kind: token.redirect, target: next.word });
  return i + 2;
}

/** 略過指令開頭的保留字、time 的選項、coproc 與 function 的名稱。 */
function skipPrefixes(tokens: BashToken[], start: number): number {
  let j = start;
  for (;;) {
    const keyword = keywordText(tokens[j]);
    if (keyword !== undefined && TRANSPARENT_KEYWORDS.has(keyword)) {
      j++;
      if (keyword === 'time') while (keywordText(tokens[j])?.startsWith('-')) j++;
      // `coproc NAME { ...; }`、`coproc NAME ( ... )`：NAME 不是指令。
      const next = tokens[j + 1];
      const compound = (next?.kind === 'word' && keywordText(next) === '{') || isOp(next, '(');
      if (keyword === 'coproc' && tokens[j]?.kind === 'word' && compound) j++;
      continue;
    }
    // zsh：`repeat N cmd`，N 不是指令（第二次驗證 zsh）。
    if (keyword === 'repeat') {
      j += tokens[j + 1]?.kind === 'word' ? 2 : 1;
      continue;
    }
    if (keyword === 'function') {
      j++;
      if (tokens[j]?.kind === 'word') j++;
      if (isOp(tokens[j], '(') && isOp(tokens[j + 1], ')')) j += 2;
      continue;
    }
    return j;
  }
}

/** 一個簡單指令或子殼層。回傳結束位置與 cd 的效果（只有單一簡單 cd 指令才有）。 */
export function parseCommand(
  tokens: BashToken[],
  i: number,
  dirs: Dirs,
  state: ParseState,
  depth: number,
  parseList: ParseList,
): { end: number; cd?: CdEffect } {
  state.budget.spend();
  const j0 = skipPrefixes(tokens, i);
  if (isOp(tokens[j0], '(')) {
    if (depth >= WRITE_GUARD_BASH_MAX_NESTING) {
      state.nestingExceeded = true;
      return { end: tokens.length };
    }
    const inner = parseList(tokens, j0 + 1, dirs, state, true, depth + 1);
    let end = inner.end + 1;
    // 子殼層之後的重導向套用在整個子殼層上。
    const trailing: SimpleCommand = {
      words: [],
      assignments: [],
      redirects: [],
      dirs,
      allDirs: [...state.seen, ...dirs],
    };
    while (tokens[end]?.kind === 'redirect') end = readRedirect(tokens, end, trailing);
    if (trailing.redirects.length > 0) state.commands.push(trailing);
    const targets = trailing.redirects.flatMap((r) => (r.target ? [r.target] : []));
    parseSubstitutions(targets, dirs, state, depth, parseList);
    return { end };
  }
  let j = j0;
  if (HEADER_KEYWORDS.has(keywordText(tokens[j]) ?? '')) {
    const header: BashWord[] = [];
    while (tokens[j] && !isOp(tokens[j], ';', '&&', '||', '|', '&', '(', ')')) {
      const token = tokens[j];
      if (token.kind === 'word') header.push(token.word);
      j++;
    }
    parseSubstitutions(header, dirs, state, depth, parseList);
    return { end: Math.max(j, i + 1) };
  }
  const command: SimpleCommand = {
    words: [],
    assignments: [],
    redirects: [],
    dirs,
    allDirs: [...state.seen, ...dirs],
  };
  while (j < tokens.length) {
    const token = tokens[j];
    if (token.kind === 'op') break;
    if (token.kind === 'redirect') {
      j = readRedirect(tokens, j, command);
      continue;
    }
    // 未加引號的 `{`、`}` 出現在參數位置：zsh 的短形式（`if [[ c ]] { rm x }`、
    // `{ a } always { rm x }`）。在這裡切開，後面當成新的指令（保守）。
    const brace = !token.word.quoted && (token.word.text === '{' || token.word.text === '}');
    if (brace && command.words.length > 0) break;
    if (command.words.length === 0 && token.word.assignment) command.assignments.push(token.word);
    else command.words.push(token.word);
    j++;
  }
  const targets = command.redirects.flatMap((r) => (r.target ? [r.target] : []));
  if (command.words.length > 0 || command.redirects.length > 0) state.commands.push(command);
  const nested = [...command.assignments, ...command.words, ...targets];
  parseSubstitutions(nested, dirs, state, depth, parseList);
  const cd = cdEffectOf(command.words);
  return cd === undefined ? { end: j } : { end: j, cd };
}
