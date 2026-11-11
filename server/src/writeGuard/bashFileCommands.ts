/**
 * 寫入類與刪除類檔案指令的路徑參數（P3 補充決定 4）。純函式；回傳的路徑段相對於
 * 指令的工作目錄。選項值不當成路徑；其餘運算元一律當成路徑（多算只會多擋，不會漏擋）。
 */

import {
  hasFlag,
  intoDirectory,
  isPathLike,
  literalSegment,
  segmentOf,
  splitArgs,
  target,
} from './bashArgs.js';
import type { BashTarget, BashWord } from './bashTypes.js';

const TARGET_DIRECTORY = ['-t', '--target-directory'];

interface CopyOptions {
  withValue: readonly string[];
  /** mv：來源被移走（遞迴命中）。 */
  move?: boolean;
  rsync?: boolean;
}

/** rsync 的遠端路徑（`host:path`、`user@host:path`、`rsync://...`）不是本機寫入。 */
const isRemote = (word: BashWord): boolean =>
  /^[^/.][^/]*:/.test(word.text) || word.text.startsWith('rsync://');

/** cp、mv、install、ln、rsync：目的地，以及「目的地是目錄」時的 <dest>/<basename(src)>。 */
export function copyLikeTargets(args: readonly BashWord[], options: CopyOptions): BashTarget[] {
  const split = splitArgs(args, [...options.withValue, ...TARGET_DIRECTORY]);
  let operands = split.operands.filter(isPathLike);
  if (options.rsync) operands = operands.filter((w) => !isRemote(w));
  const targetDir = [...TARGET_DIRECTORY.flatMap((name) => split.values.get(name) ?? [])];
  let dest: BashWord | undefined;
  let sources: BashWord[];
  if (targetDir.length > 0) {
    dest = targetDir[targetDir.length - 1];
    sources = operands;
  } else {
    dest = operands[operands.length - 1];
    sources = operands.slice(0, -1);
  }
  if (dest === undefined) return [];
  const recursive =
    options.rsync === true ||
    hasFlag(split.options, 'r', '--recursive') ||
    hasFlag(split.options, 'R') ||
    hasFlag(split.options, 'a', '--archive');
  const out: BashTarget[] = [target([segmentOf(dest)])];
  for (const source of sources) {
    out.push(target(intoDirectory(dest, source)));
    // `src/` 或 `src/.`：內容合併進 dest，整棵 dest 都可能被覆寫。
    if (recursive && /\/\.?$/.test(source.text)) out.push(target([segmentOf(dest)], 'recursive'));
    if (options.move) out.push(target([segmentOf(source)], 'recursive'));
  }
  if (options.rsync && split.options.some((o) => o.startsWith('--delete'))) {
    out.push(target([segmentOf(dest)], 'recursive'));
  }
  return out;
}

/** ln 只有一個運算元時，在工作目錄建立 basename(src)。 */
export function lnTargets(args: readonly BashWord[]): BashTarget[] {
  const withValue = ['-S', '--suffix'];
  const split = splitArgs(args, [...withValue, ...TARGET_DIRECTORY]);
  const operands = split.operands.filter(isPathLike);
  if (operands.length === 1 && !TARGET_DIRECTORY.some((name) => split.values.has(name))) {
    const base = operands[0].text.replace(/\/+$/, '').split('/').pop() ?? '';
    return base.length > 0 ? [target([literalSegment(base)])] : [];
  }
  return copyLikeTargets(args, { withValue });
}

const RSYNC_WITH_VALUE: readonly string[] = [
  '-e',
  '--rsh',
  '-f',
  '--filter',
  '--exclude',
  '--include',
  '--exclude-from',
  '--include-from',
  '--files-from',
  '--backup-dir',
  '--suffix',
  '-T',
  '--temp-dir',
  '--partial-dir',
  '--link-dest',
  '--compare-dest',
  '--copy-dest',
  '--chmod',
  '--chown',
  '--log-file',
  '--password-file',
  '--rsync-path',
  '--write-batch',
  '--only-write-batch',
];

/** rsync 會寫入的選項值（記錄檔、batch 檔）。 */
export function rsyncTargets(args: readonly BashWord[]): BashTarget[] {
  const split = splitArgs(args, RSYNC_WITH_VALUE);
  const written = ['--log-file', '--write-batch', '--only-write-batch'].flatMap(
    (name) => split.values.get(name) ?? [],
  );
  return [
    ...copyLikeTargets(args, { withValue: RSYNC_WITH_VALUE, rsync: true }),
    ...written.filter(isPathLike).map((w) => target([segmentOf(w)])),
  ];
}

/** 所有運算元都是目標（rm、touch、mkdir、tee 等）。 */
export function operandTargets(
  args: readonly BashWord[],
  withValue: readonly string[],
  mode: BashTarget['mode'],
): BashTarget[] {
  return splitArgs(args, withValue)
    .operands.filter(isPathLike)
    .map((w) => target([segmentOf(w)], mode));
}

const CHMOD_MODE = /^([0-7]+|[ugoa]*([-+=][rwxXstugo]*)+(,[ugoa]*([-+=][rwxXstugo]*)+)*)$/;

/** chmod、chown、chgrp：第一個運算元是模式或擁有者（`--reference` 時沒有）；-R 時遞迴。 */
export function modeOwnerTargets(args: readonly BashWord[], chmod: boolean): BashTarget[] {
  // chmod 的 `-w`、`-x` 等模式看起來像選項：不當成路徑也不當成選項旗標。
  const split = splitArgs(
    chmod ? args.filter((w) => !(w.text.startsWith('-') && CHMOD_MODE.test(w.text))) : args,
    [],
  );
  let operands = split.operands.filter(isPathLike);
  const reference = split.options.some((o) => o.startsWith('--reference'));
  const firstIsSpec = chmod ? CHMOD_MODE.test(operands[0]?.text ?? '') : true;
  if (!reference && firstIsSpec) operands = operands.slice(1);
  const mode = hasFlag(split.options, 'R', '--recursive') ? 'recursive' : 'direct';
  return operands.map((w) => target([segmentOf(w)], mode));
}

/** dd：只有 `of=` 是寫入目標。`of=~/x` 也做 tilde 展開（bash 對像變數指定的 word 也會展開）。 */
export function ddTargets(args: readonly BashWord[]): BashTarget[] {
  return args
    .filter((w) => w.text.startsWith('of=') && w.text.length > 3)
    .map((w) => {
      const value = w.text.slice(3);
      return target([{ text: value, tilde: value === '~' || value.startsWith('~/') }]);
    });
}

const SED_WITH_VALUE = ['-e', '-f', '--expression', '--file', '-l', '--line-length'];

/** sed 是否就地編輯（`-i`、`-i.bak`、`-ni`、`--in-place[=..]`）。 */
export function sedInPlace(args: readonly BashWord[]): boolean {
  return splitArgs(args, SED_WITH_VALUE).options.some(
    (o) => o.startsWith('--in-place') || /^-[A-Za-z]*i/.test(o),
  );
}

/** sed -i：所有運算元都當成檔案（GNU 與 BSD 的 `-i` 語意不同，多算 script 無害）。 */
export function sedTargets(args: readonly BashWord[]): BashTarget[] {
  return operandTargets(args, SED_WITH_VALUE, 'direct');
}
