/**
 * Bash 結構解析（P3，F10）：token 流 -> 簡單指令清單（含命令替換內的指令）。純函式。
 *
 * 工作目錄：同一指令字串內的 `cd X` 影響其後的指令。只有 `&&` 保證 cd 成功，
 * 所以 `cd X && cmd` 的 cmd 只在 X；`cd X; cmd`、`cd X || cmd` 之後的指令可能在
 * 原目錄或 X，兩者都記下（任一命中受保護區即命中）。子殼層 `( )`、管線中的 cd、
 * 命令替換內的 cd 不影響外層。無法精確追蹤的目錄變動（`cd -`、popd、`cd $X`）之後，
 * 解析目錄擴為「到目前為止出現過的所有候選」的聯集（含起始目錄，保守）。
 *
 * 巢狀（子殼層、命令替換）計入 WRITE_GUARD_BASH_MAX_NESTING；超過時標記無法解析並停止，
 * 不會遞迴到堆疊溢位（驗證 F-1）。
 */

import { WRITE_GUARD_BASH_MAX_DIR_CHAINS, WRITE_GUARD_BASH_MAX_NESTING } from '../constants.js';
import { WorkBudget } from './bashBudget.js';
import type { CdEffect, Dirs, ParseState } from './bashCommandParse.js';
import { isOp, parseCommand } from './bashCommandParse.js';
import { lexBash } from './bashLexer.js';
import type { BashToken, BashWord, ParsedScript } from './bashTypes.js';

function chainKey(chain: BashWord[]): string {
  return JSON.stringify(chain.map((w) => [w.text, w.tilde]));
}

function union(state: ParseState, ...sets: Dirs[]): Dirs {
  const out: Dirs = [];
  const seen = new Set<string>();
  for (const chain of sets.flat()) {
    const key = chainKey(chain);
    if (seen.has(key)) continue;
    if (out.length >= WRITE_GUARD_BASH_MAX_DIR_CHAINS) {
      state.dirsTruncated = true;
      break;
    }
    seen.add(key);
    out.push(chain);
  }
  return out;
}

/** cd 之後的可能工作目錄；同時記入「出現過的所有候選」。 */
function applyCd(state: ParseState, cur: Dirs, cd: CdEffect): Dirs {
  const applied =
    cd === 'imprecise' ? union(state, state.seen, cur) : cur.map((chain) => [...chain, cd.precise]);
  state.seen = union(state, state.seen, applied);
  return applied;
}

/** 一串以 `;`、`&`、換行分隔的 and-or list。回傳結束位置與其後的可能工作目錄。 */
function parseList(
  tokens: BashToken[],
  start: number,
  dirs: Dirs,
  state: ParseState,
  untilParen: boolean,
  depth: number,
): { end: number; dirs: Dirs } {
  if (depth > WRITE_GUARD_BASH_MAX_NESTING) {
    state.nestingExceeded = true;
    return { end: tokens.length, dirs };
  }
  let i = start;
  let current = dirs;
  while (i < tokens.length) {
    const iterationStart = i;
    if (isOp(tokens[i], ')')) {
      if (untilParen) return { end: i, dirs: current };
      i++;
      continue;
    }
    if (isOp(tokens[i], ';', '&', '&&', '||', '|')) {
      i++;
      continue;
    }
    // and-or list：pipeline 以 && / || 串接。
    let cur = current;
    let variants = current;
    for (;;) {
      const pipelineCds: CdEffect[] = [];
      let elements = 0;
      for (;;) {
        const result = parseCommand(tokens, i, cur, state, depth, parseList);
        if (result.cd) pipelineCds.push(result.cd);
        elements++;
        i = Math.max(result.end, i);
        if (!isOp(tokens[i], '|')) break;
        i++;
      }
      // 單一 cd：之後在新目錄。管線中任何元素的 cd（bash 的 lastpipe、zsh 預設在目前殼層
      // 執行末段）：之後的目錄可能變也可能不變，兩者都算（第二次驗證 P3）。
      const applied =
        pipelineCds.length === 0
          ? undefined
          : elements === 1
            ? applyCd(state, cur, pipelineCds[0])
            : union(state, cur, ...pipelineCds.map((cd) => applyCd(state, cur, cd)));
      if (applied) variants = union(state, variants, applied);
      if (isOp(tokens[i], '&&')) {
        if (applied) cur = applied;
        i++;
        continue;
      }
      if (isOp(tokens[i], '||')) {
        cur = variants;
        i++;
        continue;
      }
      break;
    }
    current = union(state, current, variants);
    // 這一輪完全沒有前進時強制前進，保證終止；有前進時不跳過任何 token（`if (c) rm x` 這種
    // csh 風格的 rm 必須被解析，第二次驗證 zsh）。
    if (i === iterationStart) i++;
  }
  return { end: i, dirs: current };
}

/** 解析一整段指令字串。 */
export function parseBash(src: string, budget: WorkBudget = new WorkBudget()): ParsedScript {
  const lexed = lexBash(src, budget);
  const state: ParseState = {
    commands: [],
    dirsTruncated: false,
    nestingExceeded: false,
    seen: [[]],
    budget,
  };
  parseList(lexed.tokens, 0, [[]], state, false, 0);
  return {
    commands: state.commands,
    nestingExceeded: lexed.nestingExceeded || state.nestingExceeded,
    dirsTruncated: state.dirsTruncated,
  };
}
