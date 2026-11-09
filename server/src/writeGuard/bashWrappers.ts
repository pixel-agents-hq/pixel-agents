/**
 * 包裝指令（P3）：以內層指令分類（sudo rm 就是 rm）。純函式。
 *
 * 每個包裝指令的選項表：
 * - withValue：會吃掉下一個參數的選項（值不是內層指令）；
 * - chdir：改變內層指令工作目錄的選項（`env -C`、`sudo -D`）；
 * - commandString：值是一段指令（`env -S 'rm -rf x'`、`flock -c 'cmd'`）：把值當成指令
 *   解析分類，另外視為無法分類（需要 edit，並掃描所有 word 的字面路徑）（驗證 F-2）；
 * - outputFile：值是寫入的檔案（`time -o f`、`strace -o f`）：寫入目標，並繼續找內層指令；
 * - editsOperands：運算元是被編輯的檔案（`sudo -e`）：無法分類；
 * - skipOperands：內層指令之前的運算元數（timeout 的 DURATION、flock 的鎖檔）；
 * - bareRead：沒有內層指令時是讀取類（env 印出環境、xargs 預設 echo）。
 */

import { segmentOf } from './bashArgs.js';
import type { BashWord, PathSegment } from './bashTypes.js';

interface Wrapper {
  withValue: readonly string[];
  chdir?: readonly string[];
  commandString?: readonly string[];
  outputFile?: readonly string[];
  editsOperands?: readonly string[];
  skipOperands?: number;
  assignments?: boolean;
  bareRead?: boolean;
}

const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  sudo: {
    withValue: [
      '-u',
      '-g',
      '-h',
      '-p',
      '-C',
      '-r',
      '-t',
      '-U',
      '-T',
      '-c',
      '--user',
      '--group',
      '--host',
      '--prompt',
      '--close-from',
      '--role',
      '--type',
      '--other-user',
      '--command-timeout',
      '--login-class',
    ],
    chdir: ['-D', '--chdir'],
    // 編輯檔案（sudoedit）、改變根目錄（路徑意義改變）：無法分類。
    editsOperands: ['-e', '--edit', '-R', '--chroot'],
  },
  doas: { withValue: ['-u', '-C', '-a'] },
  env: {
    withValue: ['-u', '-C', '-P', '--unset', '--chdir'],
    chdir: ['-C', '--chdir'],
    commandString: ['-S', '--split-string'],
    assignments: true,
    bareRead: true,
  },
  nice: { withValue: ['-n', '--adjustment'] },
  nohup: { withValue: [] },
  command: { withValue: [] },
  builtin: { withValue: [] },
  exec: { withValue: ['-a'] },
  timeout: { withValue: ['-s', '-k', '--signal', '--kill-after'], skipOperands: 1 },
  stdbuf: { withValue: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  ionice: {
    withValue: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'],
  },
  xargs: {
    withValue: [
      '-I',
      '-n',
      '-P',
      '-L',
      '-s',
      '-d',
      '-E',
      '-a',
      '--max-args',
      '--max-procs',
      '--max-lines',
      '--max-chars',
      '--delimiter',
      '--arg-file',
      '--replace',
      '--eof',
      '--process-slot-var',
    ],
    bareRead: true,
  },
  time: { withValue: ['-f', '--format'], outputFile: ['-o', '--output'] },
  setsid: { withValue: [] },
  caffeinate: { withValue: ['-t', '-w'] },
  unbuffer: { withValue: [] },
  chronic: { withValue: [] },
  flock: {
    withValue: ['-w', '-E', '--timeout', '--conflict-exit-code'],
    commandString: ['-c', '--command'],
    skipOperands: 1,
  },
  taskset: { withValue: [], skipOperands: 1 },
  strace: {
    withValue: ['-e', '-p', '-s', '-u', '-P', '-a', '-b', '-E', '-I', '-S', '-X'],
    outputFile: ['-o', '--output'],
  },
  watch: { withValue: ['-n', '--interval'] },
  // zsh 的前置修飾字。
  noglob: { withValue: [] },
  nocorrect: { withValue: [] },
};

export function isWrapper(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WRAPPERS, name);
}

export function wrapperBareRead(name: string): boolean {
  return WRAPPERS[name]?.bareRead === true;
}

type OptionKind = 'command' | 'edits' | 'chdir' | 'output' | 'value' | 'flag';

/** 一個選項的分類、值與吃掉的參數數。 */
interface ReadOption {
  kind: OptionKind;
  value?: BashWord;
  consumed: number;
}

function kindOf(wrapper: Wrapper, option: string): OptionKind | null {
  if (wrapper.commandString?.includes(option)) return 'command';
  if (wrapper.editsOperands?.includes(option)) return 'edits';
  if (wrapper.chdir?.includes(option)) return 'chdir';
  if (wrapper.outputFile?.includes(option)) return 'output';
  if (wrapper.withValue.includes(option)) return 'value';
  return null;
}

const takesValue = (kind: OptionKind | null): boolean =>
  kind === 'command' || kind === 'chdir' || kind === 'output' || kind === 'value';

/**
 * 讀一個選項（驗證 F-2、F-5，第二次驗證 P2-1）：長選項 `--x v` 與 `--x=v`；短選項逐字元
 * 解析合併旗標，第一個會吃值的選項吃掉其後的剩餘文字（`-CX`、`-iSv`、`-uVAR`）或下一個
 * 參數（`-C X`、`-iS v`）。合併旗標中出現 editsOperands 的字母也算。
 */
function readOption(wrapper: Wrapper, args: readonly BashWord[], i: number): ReadOption {
  const word = args[i];
  const text = word.text;
  if (text.startsWith('--')) {
    const eq = text.indexOf('=');
    const name = eq > 0 ? text.slice(0, eq) : text;
    const kind = kindOf(wrapper, name) ?? 'flag';
    if (eq > 0) return { kind, value: { ...word, text: text.slice(eq + 1) }, consumed: 1 };
    return takesValue(kind) ? { kind, value: args[i + 1], consumed: 2 } : { kind, consumed: 1 };
  }
  let edits = false;
  for (let k = 1; k < text.length; k++) {
    const kind = kindOf(wrapper, `-${text[k]}`);
    if (kind === 'edits') edits = true;
    if (!takesValue(kind)) continue;
    const rest = text.slice(k + 1);
    if (edits) return { kind: 'edits', consumed: 1 };
    return rest.length > 0
      ? { kind: kind as OptionKind, value: { ...word, text: rest }, consumed: 1 }
      : { kind: kind as OptionKind, value: args[i + 1], consumed: 2 };
  }
  return { kind: edits ? 'edits' : 'flag', consumed: 1 };
}

export type Unwrapped =
  | {
      kind: 'inner';
      words: BashWord[];
      prefix: PathSegment[];
      assignments: BashWord[];
      outputs: BashWord[];
    }
  | { kind: 'bare'; outputs: BashWord[] }
  | { kind: 'commandString'; text: string }
  | { kind: 'unclassified' };

/** 包裝指令的內層。 */
export function unwrap(name: string, args: readonly BashWord[]): Unwrapped {
  const wrapper = WRAPPERS[name];
  const prefix: PathSegment[] = [];
  const assignments: BashWord[] = [];
  const outputs: BashWord[] = [];
  let i = 0;
  let skip = wrapper.skipOperands ?? 0;
  while (i < args.length) {
    const text = args[i].text;
    if (text === '--') {
      i++;
      break;
    }
    if (wrapper.assignments && args[i].assignment) {
      assignments.push(args[i]);
      i++;
      continue;
    }
    if (text.startsWith('-') && text !== '-') {
      const option = readOption(wrapper, args, i);
      if (option.kind === 'command')
        return { kind: 'commandString', text: option.value?.text ?? '' };
      if (option.kind === 'edits') return { kind: 'unclassified' };
      if (option.kind === 'chdir' && option.value) prefix.push(segmentOf(option.value));
      if (option.kind === 'output' && option.value) outputs.push(option.value);
      i += option.consumed;
      continue;
    }
    if (skip > 0) {
      skip--;
      i++;
      continue;
    }
    break;
  }
  if (i >= args.length) return { kind: 'bare', outputs };
  return { kind: 'inner', words: args.slice(i), prefix, assignments, outputs };
}
