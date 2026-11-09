/**
 * git 與 find 的分類（P3 補充決定 4）。純函式；路徑段相對於指令的工作目錄。
 */

import type { CommandEffect } from './bashArgs.js';
import { isPathLike, segmentOf, splitArgs, target } from './bashArgs.js';
import { copyLikeTargets } from './bashFileCommands.js';
import type { BashTarget, BashWord, PathSegment } from './bashTypes.js';

const GIT_READ = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'ls-files',
  'rev-parse',
  'grep',
  'ls-tree',
  'cat-file',
  'describe',
  'shortlog',
  'show-ref',
]);
const GIT_EDIT = new Set([
  'add',
  'commit',
  'checkout',
  'switch',
  'restore',
  'merge',
  'rebase',
  'pull',
  'apply',
  'am',
  'stash',
  'cherry-pick',
  'revert',
  'reset',
  'mv',
  'tag',
]);
const GIT_DELETE = new Set(['rm', 'clean']);
/** pathspec 會整棵覆寫的子命令（`git checkout .`）：運算元遞迴命中。 */
const GIT_RECURSIVE_PATHSPEC = new Set(['checkout', 'restore']);
/** 運算元是工作樹路徑的子命令（其餘子命令的運算元是 ref 或訊息，不當成路徑）。 */
const GIT_PATH_OPERANDS = new Set(['checkout', 'restore', 'reset', 'stash', 'mv', 'rm', 'clean']);
const GIT_GLOBAL_WITH_VALUE = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
];
const BRANCH_WITH_VALUE = [
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
];
const BRANCH_WRITE_FLAGS =
  /^-([a-zA-Z]*[dDmMcCfut]|-(delete|move|copy|force|set-upstream|unset-upstream|edit-description|track|no-track))/;

const effect = (
  ops: CommandEffect['ops'],
  targets: BashTarget[] = [],
  mentions: BashWord[] = [],
) => ({
  ops,
  targets,
  mentions,
});

function branchIsReadOnly(args: readonly BashWord[]): boolean {
  const split = splitArgs(args, BRANCH_WITH_VALUE);
  if (split.options.some((o) => BRANCH_WRITE_FLAGS.test(o))) return false;
  const listing = split.options.some((o) => ['--list', '-l', '--show-current'].includes(o));
  return listing || split.operands.length === 0;
}

function remoteIsReadOnly(args: readonly BashWord[]): boolean {
  const split = splitArgs(args, []);
  const sub = split.operands[0]?.text;
  return sub === undefined || sub === 'show' || sub === 'get-url';
}

/**
 * git 的全域選項：`-C <dir>`（含 `-C<dir>`）累加起點；`--work-tree`、`--git-dir`
 * （含 `=` 形式）以及 GIT_WORK_TREE／GIT_DIR 變數指定也會讓路徑運算元的起點偏移
 * （驗證 F-8）。回傳所有起點候選：原起點（含 -C）、work tree、git dir 的上層。
 */
function gitBases(
  args: readonly BashWord[],
  assignments: readonly BashWord[],
): { bases: PathSegment[][]; next: number } {
  const prefix: PathSegment[] = [];
  const extra: PathSegment[][] = [];
  const addWorkTree = (value: PathSegment) => extra.push([value]);
  const addGitDir = (value: PathSegment) => extra.push([value, { text: '..', tilde: false }]);
  const valueOf = (text: string): PathSegment => ({
    text,
    tilde: text === '~' || text.startsWith('~/'),
  });
  for (const word of assignments) {
    const [key, ...rest] = word.text.split('=');
    if (key === 'GIT_WORK_TREE') addWorkTree(valueOf(rest.join('=')));
    if (key === 'GIT_DIR') addGitDir(valueOf(rest.join('=')));
  }
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const option = args[i].text;
    const eq = option.indexOf('=');
    const name = eq > 0 ? option.slice(0, eq) : option;
    const inline = eq > 0 ? option.slice(eq + 1) : undefined;
    if (option.startsWith('-C') && option.length > 2) {
      prefix.push(valueOf(option.slice(2)));
      i++;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.includes(name)) {
      const value = inline !== undefined ? valueOf(inline) : args[i + 1] && segmentOf(args[i + 1]);
      i += inline !== undefined ? 1 : 2;
      if (value === undefined) continue;
      if (name === '-C') prefix.push(value);
      if (name === '--work-tree') addWorkTree(value);
      if (name === '--git-dir') addGitDir(value);
      continue;
    }
    i++;
  }
  const bases = [prefix, ...extra.map((base) => [...prefix, ...base])];
  return { bases, next: i };
}

/** git：子命令分類與路徑運算元（每個起點候選各一個目標）。 */
export function classifyGit(
  args: readonly BashWord[],
  assignments: readonly BashWord[] = [],
): Omit<CommandEffect, 'name'> {
  const { bases, next: i } = gitBases(args, assignments);
  const under = (segments: PathSegment[], mode: BashTarget['mode'] = 'direct'): BashTarget[] =>
    bases.map((base) => target([...base, ...segments], mode));
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (sub === undefined) return effect(['read']);
  if (GIT_READ.has(sub)) {
    // `git diff --output=<file>`、`git log --output <file>` 會寫檔。
    const output = splitArgs(rest, ['--output']).values.get('--output') ?? [];
    return output.length > 0
      ? effect(
          ['read', 'edit'],
          output.flatMap((w) => under([segmentOf(w)])),
        )
      : effect(['read']);
  }
  if (sub === 'branch' && branchIsReadOnly(rest)) return effect(['read']);
  if (sub === 'remote' && remoteIsReadOnly(rest)) return effect(['read']);
  const isDelete = GIT_DELETE.has(sub);
  if (!isDelete && !GIT_EDIT.has(sub) && sub !== 'branch' && sub !== 'remote') {
    return effect(['edit'], [], [...args]);
  }
  const ops: CommandEffect['ops'] = [isDelete ? 'delete' : 'edit'];
  if (!GIT_PATH_OPERANDS.has(sub)) return effect(ops);
  if (sub === 'mv') {
    const moved = copyLikeTargets(rest, { withValue: [], move: true });
    return effect(
      ops,
      moved.flatMap((t) => under(t.segments, t.mode)),
    );
  }
  const mode = isDelete || GIT_RECURSIVE_PATHSPEC.has(sub) ? 'recursive' : 'direct';
  const operands = splitArgs(rest, ['-m', '--message', '-b', '-B', '--source', '-s']).operands;
  let paths = operands.filter(isPathLike).flatMap((w) => under([segmentOf(w)], mode));
  // `git clean` 不帶路徑時清整個工作目錄。
  if (sub === 'clean' && paths.length === 0) {
    paths = under([{ text: '.', tilde: false }], 'recursive');
  }
  return effect(ops, paths);
}

const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];
const FIND_WRITES = ['-fprint', '-fprint0', '-fprintf', '-fls'];

/**
 * find：起點是第一個運算式之前的參數（預設 `.`）。`-delete` 是刪除；
 * `-exec` 等不是讀取類（無法分類，需要 edit，並掃描字面路徑；執行的指令不解析，已知限制）；
 * `-fprint` 等的檔案是寫入目標。
 */
export function classifyFind(allArgs: readonly BashWord[]): Omit<CommandEffect, 'name'> {
  // 起點之前的全域選項：-H、-L、-P、-D <debugopts>、-O<level>（第二次驗證 P2-6）。
  let skip = 0;
  while (skip < allArgs.length) {
    const text = allArgs[skip].text;
    if (/^-[HLP]+$/.test(text) || /^-O\d*$/.test(text)) skip += text === '-O' ? 2 : 1;
    else if (text === '-D') skip += 2;
    else break;
  }
  const args = allArgs.slice(skip);
  const startEnd = args.findIndex((w) => /^[-(!)]/.test(w.text) && w.text !== '-');
  const starts = (startEnd < 0 ? args : args.slice(0, startEnd)).filter(isPathLike);
  const expression = startEnd < 0 ? [] : args.slice(startEnd);
  const texts = expression.map((w) => w.text);
  const roots = starts.length > 0 ? starts.map(segmentOf) : [{ text: '.', tilde: false }];
  const written: BashTarget[] = [];
  expression.forEach((w, i) => {
    const next = expression[i + 1];
    if (FIND_WRITES.includes(w.text) && next) written.push(target([segmentOf(next)]));
  });
  if (texts.includes('-delete')) {
    return effect(['delete'], [...roots.map((root) => target([root], 'recursive')), ...written]);
  }
  if (texts.some((t) => FIND_EXEC.includes(t))) return effect(['edit'], written, [...allArgs]);
  if (written.length > 0) return effect(['read', 'edit'], written);
  return effect(['read']);
}
