/**
 * Bash 指令參數的共用工具（P3）：選項與運算元的切分、路徑段的組成。純函式。
 */

import type { BashTarget, BashWord, GuardOperation, PathSegment } from './bashTypes.js';

/** 一個簡單指令的分類結果（路徑段相對於該指令的工作目錄，尚未接上 cd）。 */
export interface CommandEffect {
  /** 指令名稱（basename）；拒絕訊息用。 */
  name: string;
  ops: GuardOperation[];
  targets: BashTarget[];
  /** 要掃描字面路徑片段的 word（直譯器與無法分類的指令）。 */
  mentions: BashWord[];
  /** 無法分類的指令（可能寫入工作目錄本身）。 */
  unclassified?: boolean;
}

export const segmentOf = (word: BashWord): PathSegment => ({
  text: word.text,
  tilde: word.tilde,
  ...(word.tildeKind ? { kind: word.tildeKind } : {}),
  ...(word.unresolved ? { unresolved: true } : {}),
});

export const literalSegment = (text: string): PathSegment => ({ text, tilde: false });

export function target(segments: PathSegment[], mode: BashTarget['mode'] = 'direct'): BashTarget {
  return { segments, mode };
}

/** 空字串不是路徑（例如 BSD `sed -i ''` 的副檔名參數）。 */
export const isPathLike = (word: BashWord): boolean => word.text.length > 0;

export interface SplitArgs {
  /** 原樣的選項字串（含 `--x=v`）。 */
  options: string[];
  /** 非選項參數，以及 `--` 之後的全部參數。 */
  operands: BashWord[];
  /** 帶值選項（`-t DIR`、`--target-directory=DIR`）的值，依選項名稱。 */
  values: Map<string, BashWord[]>;
}

/**
 * 切分選項與運算元。withValue 內的選項（短選項完整比對或黏著值 `-tDIR`、長選項含 `=v`
 * 形式）會吃掉下一個參數當作值。單獨的 `-` 是運算元（stdin/stdout）。
 */
export function splitArgs(args: readonly BashWord[], withValue: readonly string[] = []): SplitArgs {
  const options: string[] = [];
  const operands: BashWord[] = [];
  const values = new Map<string, BashWord[]>();
  const addValue = (name: string, value: BashWord): void => {
    const list = values.get(name);
    if (list) list.push(value);
    else values.set(name, [value]);
  };
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const text = arg.text;
    if (afterDashDash || !text.startsWith('-') || text === '-') {
      operands.push(arg);
      continue;
    }
    if (text === '--') {
      afterDashDash = true;
      continue;
    }
    options.push(text);
    const eq = text.indexOf('=');
    if (text.startsWith('--') && eq > 0) {
      const name = text.slice(0, eq);
      if (withValue.includes(name)) addValue(name, { ...arg, text: text.slice(eq + 1) });
      continue;
    }
    // 短選項黏著值：`-tDIR`（驗證 F-5）。
    const short = text.slice(0, 2);
    if (!text.startsWith('--') && text.length > 2 && withValue.includes(short)) {
      addValue(short, { ...arg, text: text.slice(2) });
      continue;
    }
    if (withValue.includes(text) && i + 1 < args.length) {
      addValue(text, args[i + 1]);
      i++;
    }
  }
  return { options, operands, values };
}

/** 是否帶有某個短旗標（可合併：`-rf`）或長選項。 */
export function hasFlag(options: readonly string[], short: string, long?: string): boolean {
  return options.some(
    (option) =>
      (long !== undefined && (option === long || option.startsWith(`${long}=`))) ||
      (/^-[A-Za-z]+$/.test(option) && option.includes(short)),
  );
}

/** 目錄 dest 下的 basename(src)：dest 是既有目錄時，cp/mv/ln 實際寫到這裡。 */
export function intoDirectory(dest: BashWord, source: BashWord): PathSegment[] {
  const trimmed = source.text.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (base.length === 0 || base === '.' || base === '..') return [segmentOf(dest)];
  return [segmentOf(dest), literalSegment(base)];
}
