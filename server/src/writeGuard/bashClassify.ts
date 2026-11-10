/**
 * Bash 簡單指令的分類表（P3 補充決定 4）。純函式。
 *
 * - 讀取類（read）、寫入類（edit）、刪除類（delete）依指令名稱（basename）查表；
 * - git、find、sed 依子命令或選項；
 * - 包裝指令（sudo、env、nice、timeout、xargs 等）以其內層指令分類；
 * - 其餘（含 npm、npx、python、node、make、bash -c 等）無法分類：需要 edit，
 *   並掃描其所有 word 中字面出現的路徑片段。
 */

import type { CommandEffect } from './bashArgs.js';
import { segmentOf, splitArgs, target } from './bashArgs.js';
import {
  copyLikeTargets,
  ddTargets,
  lnTargets,
  modeOwnerTargets,
  operandTargets,
  rsyncTargets,
  sedInPlace,
  sedTargets,
} from './bashFileCommands.js';
import { classifyFind, classifyGit } from './bashGitFind.js';
import { parseBash } from './bashParser.js';
import type { BashTarget, BashWord } from './bashTypes.js';
import { isWrapper, unwrap, wrapperBareRead } from './bashWrappers.js';

/** 讀取類指令（決定 4 的清單，加上 cd 等不寫檔的導覽與查詢指令）。 */
export const BASH_READ_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'stat',
  'file',
  'du',
  'df',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'printenv',
  'date',
  'cd',
  'pushd',
  'popd',
  'true',
  'false',
  ':',
  'test',
  '[',
  '[[',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'whoami',
  'id',
  'uname',
  'hostname',
  'sleep',
  'diff',
  'cmp',
]);

type Classifier = (args: readonly BashWord[]) => Omit<CommandEffect, 'name'>;

const edit = (targets: BashTarget[]) => ({ ops: ['edit' as const], targets, mentions: [] });
const remove = (targets: BashTarget[]) => ({ ops: ['delete' as const], targets, mentions: [] });

const CLASSIFIERS: Readonly<Record<string, Classifier>> = {
  tee: (a) => edit(operandTargets(a, [], 'direct')),
  cp: (a) => edit(copyLikeTargets(a, { withValue: ['-S', '--suffix'] })),
  mv: (a) => edit(copyLikeTargets(a, { withValue: ['-S', '--suffix'], move: true })),
  install: (a) => {
    const withValue = ['-m', '-o', '-g', '-S', '--mode', '--owner', '--group', '--suffix'];
    const split = splitArgs(a, withValue);
    return split.options.includes('-d') || split.options.includes('--directory')
      ? edit(operandTargets(a, withValue, 'direct'))
      : edit(copyLikeTargets(a, { withValue }));
  },
  ln: (a) => edit(lnTargets(a)),
  rsync: (a) => edit(rsyncTargets(a)),
  touch: (a) => edit(operandTargets(a, ['-d', '-t', '-r', '--date', '--reference'], 'direct')),
  mkdir: (a) => edit(operandTargets(a, ['-m', '--mode', '--context'], 'direct')),
  truncate: (a) => edit(operandTargets(a, ['-s', '-r', '--size', '--reference'], 'direct')),
  chmod: (a) => edit(modeOwnerTargets(a, true)),
  chown: (a) => edit(modeOwnerTargets(a, false)),
  chgrp: (a) => edit(modeOwnerTargets(a, false)),
  dd: (a) => edit(ddTargets(a)),
  rm: (a) => remove(operandTargets(a, [], 'recursive')),
  rmdir: (a) => remove(operandTargets(a, [], 'recursive')),
  unlink: (a) => remove(operandTargets(a, [], 'direct')),
  shred: (a) => remove(operandTargets(a, ['-n', '-s', '--iterations', '--size'], 'direct')),
  sed: (a) =>
    sedInPlace(a) ? edit(sedTargets(a)) : { ops: ['edit'], targets: [], mentions: [...a] },
};

/** 指令名稱：去掉目錄；含展開（`$CMD`）時回 null（無法分類）。 */
/**
 * 指令名稱：去掉目錄與 zsh 的 `=cmd` 前綴；含展開（`$CMD`）時回 null（無法分類）。
 * darwin、win32 的預設檔案系統不分大小寫（`RM`、`/bin/Rm` 就是 rm），轉小寫後再分類；
 * win32 另去掉 .exe、.cmd、.bat、.com（第二次驗證 P2-7）。linux 不轉。
 */
export function commandName(
  word: BashWord,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (word.expansion) return null;
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  const parts = word.text.split(separators);
  let name = parts[parts.length - 1] ?? '';
  if (name.startsWith('=') && name.length > 1) name = name.slice(1);
  if (platform === 'darwin' || platform === 'win32') name = name.toLowerCase();
  if (platform === 'win32') name = name.replace(/\.(exe|cmd|bat|com)$/, '');
  return name;
}

/**
 * `env -S 'rm -rf x'`、`flock -c 'cmd'`：值本身是一段指令。解析並分類其中每個簡單指令
 * （所以 rm 仍需要 D），另外視為無法分類（需要 edit，並掃描所有 word 的字面路徑）。
 */
function commandStringEffect(
  name: string,
  words: readonly BashWord[],
  text: string,
  depth: number,
  platform: NodeJS.Platform,
): CommandEffect {
  const out = unclassified(name, words);
  const ops = new Set(out.ops);
  const parsed = parseBash(text);
  // 字串裡的結構無法完整解析：可能藏著任何指令（保守）。
  if (parsed.nestingExceeded) ['edit', 'delete'].forEach((op) => ops.add(op as 'edit' | 'delete'));
  for (const command of parsed.commands) {
    const effect = classifyWords(command.words, depth + 1, command.assignments, platform);
    for (const op of effect.ops) ops.add(op);
    out.targets.push(...effect.targets);
    out.mentions.push(...effect.mentions);
  }
  return { ...out, ops: (['read', 'edit', 'delete'] as const).filter((op) => ops.has(op)) };
}

const unclassified = (name: string, words: readonly BashWord[]): CommandEffect => ({
  name,
  ops: ['edit'],
  targets: [],
  mentions: [...words],
  unclassified: true,
});

/**
 * 分類一個簡單指令的 argv（不含重導向）。assignments 是指令前的變數指定
 * （`GIT_WORK_TREE=x git ...`、`env GIT_DIR=x git ...`），只有 git 會用到。
 */
export function classifyWords(
  words: readonly BashWord[],
  depth = 0,
  assignments: readonly BashWord[] = [],
  platform: NodeJS.Platform = process.platform,
): CommandEffect {
  const name = words.length > 0 ? commandName(words[0], platform) : '';
  const args = words.slice(1);
  if (name === null) return unclassified(words[0].text, words);
  if (name === '') return { name, ops: [], targets: [], mentions: [] };
  if (isWrapper(name) && depth < 8) {
    if (name === 'command' && args.some((w) => w.text === '-v' || w.text === '-V')) {
      return { name, ops: ['read'], targets: [], mentions: [] };
    }
    const inner = unwrap(name, args);
    if (inner.kind === 'unclassified') return unclassified(name, words);
    if (inner.kind === 'commandString') {
      return commandStringEffect(name, words, inner.text, depth, platform);
    }
    const outputs = inner.outputs.map((w) => target([segmentOf(w)]));
    const withOutputs = (effect: CommandEffect): CommandEffect =>
      outputs.length === 0
        ? effect
        : {
            ...effect,
            ops: effect.ops.includes('edit') ? effect.ops : [...effect.ops, 'edit'],
            targets: [...effect.targets, ...outputs],
          };
    if (inner.kind === 'bare') {
      return withOutputs(
        wrapperBareRead(name)
          ? { name, ops: ['read'], targets: [], mentions: [] }
          : unclassified(name, words),
      );
    }
    const effect = classifyWords(
      inner.words,
      depth + 1,
      [...assignments, ...inner.assignments],
      platform,
    );
    return withOutputs({
      ...effect,
      targets: effect.targets.map((t) => target([...inner.prefix, ...t.segments], t.mode)),
    });
  }
  if (BASH_READ_COMMANDS.has(name)) return { name, ops: ['read'], targets: [], mentions: [] };
  if (name === 'git') return { name, ...classifyGit(args, assignments) };
  if (name === 'find') return { name, ...classifyFind(args) };
  if (Object.prototype.hasOwnProperty.call(CLASSIFIERS, name)) {
    const effect = CLASSIFIERS[name](args);
    // 檔案指令的參數若含命令替換或變數（`rm "$(echo /w/.note)"`），值在執行期才知道；
    // 短選項也可能黏著值（`cp -t.note/x a`，驗證 F-5）。兩者中字面出現的路徑片段都要檢查。
    const extra = args.filter((w) => w.expansion || (/^-[^-]/.test(w.text) && w.text.length > 2));
    return { name, ...effect, mentions: [...effect.mentions, ...extra] };
  }
  return unclassified(name, words);
}
