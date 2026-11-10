/**
 * Bash 指令字串的分析（P3，F10）：需要的操作類別、寫入目標、字面路徑片段。純函式，
 * hook 端與伺服器端共用；路徑段的解析交給 bashPaths.ts（那裡才碰檔案系統）。
 *
 * 永不拋出；工作量有確定性的上限（bashBudget.ts）。無法解析（例外、預算用完、巢狀超限、
 * zsh 的執行型展開）時一律保守：操作類別加上 edit 與 delete，寫入目標視為無法判斷。
 */

import { WRITE_GUARD_BASH_MAX_TARGETS, WRITE_GUARD_BASH_NON_WRITE_TARGETS } from '../constants.js';
import { segmentOf, target } from './bashArgs.js';
import { BashBudgetExceeded, WorkBudget } from './bashBudget.js';
import { classifyWords } from './bashClassify.js';
import { fragmentsOfText, pathFragments } from './bashFragments.js';
import { parseBash } from './bashParser.js';
import type {
  BashAnalysis,
  BashTarget,
  GuardOperation,
  PathSegment,
  SimpleCommand,
} from './bashTypes.js';
import { hasZshExecExpansion } from './bashZsh.js';

const OPERATION_ORDER: readonly GuardOperation[] = ['read', 'edit', 'delete'];
/** 只有 fd 編號或 `-`：`2>&1`、`>&-` 是複製檔案描述子，不是檔案。 */
const FD_DUP = /^(\d+|-)$/;
/** 重導向只有運算子沒有指令時，拒絕訊息用的指令片段。 */
export const REDIRECT_FRAGMENT = '>';

export interface AnalyzeOptions {
  /** 指令名稱的大小寫語意（darwin、win32 不分大小寫）；預設目前平台。 */
  platform?: NodeJS.Platform;
  /** 測試用：工作量預算。 */
  budget?: WorkBudget;
}

interface Collector {
  ops: Set<GuardOperation>;
  opSources: Partial<Record<GuardOperation, string>>;
  targets: BashTarget[];
  mentions: BashTarget[];
  literalTexts: string[];
  truncated: boolean;
  budget: WorkBudget;
}

function addOp(c: Collector, op: GuardOperation, source: string): void {
  c.ops.add(op);
  c.opSources[op] ??= source;
}

function push(c: Collector, list: BashTarget[], item: BashTarget): void {
  c.budget.spend();
  if (list.length >= WRITE_GUARD_BASH_MAX_TARGETS) {
    c.truncated = true;
    return;
  }
  list.push(item);
}

/** `~+/x`、`~-/x` 換成相對於（目前或出現過的所有）工作目錄的 `./x`。 */
const relativeToDir = (segment: PathSegment): PathSegment => ({
  text: `.${segment.text.replace(/^~[^/]*/, '')}`,
  tilde: false,
});

/**
 * 依指令的每個可能工作目錄，把相對路徑段接在 cd 參數之後（第二次驗證 P2-3）：
 * `~+` 用目前的候選、`~-`／`~N` 用出現過的所有候選；`~user` 與無法解碼的段無法判斷。
 */
function underDirs(c: Collector, command: SimpleCommand, t: BashTarget): BashTarget[] {
  if (t.segments.some((s) => s.unresolved || s.kind === 'user')) c.truncated = true;
  const minus = t.segments.some((s) => s.kind === 'minus');
  const segments = t.segments.map((s) =>
    s.kind === 'plus' || s.kind === 'minus' ? relativeToDir(s) : s,
  );
  const dirs = minus ? command.allDirs : command.dirs;
  return dirs.map((chain) => target([...chain.map(segmentOf), ...segments], t.mode));
}

function addMentions(c: Collector, command: SimpleCommand, fragments: PathSegment[]): void {
  for (const fragment of fragments) {
    for (const t of underDirs(c, command, target([fragment]))) push(c, c.mentions, t);
  }
}

function addLiteral(c: Collector, text: string): void {
  c.budget.spend(text.length);
  if (text.length > 0) c.literalTexts.push(text);
}

function collect(c: Collector, command: SimpleCommand, platform: NodeJS.Platform): void {
  const effect = classifyWords(command.words, 0, command.assignments, platform);
  const name = effect.name.length > 0 ? effect.name : REDIRECT_FRAGMENT;
  const spend = (n: number) => c.budget.spend(n);
  for (const op of effect.ops) addOp(c, op, name);
  for (const t of effect.targets) for (const t2 of underDirs(c, command, t)) push(c, c.targets, t2);
  for (const word of effect.mentions) {
    if (word.unresolved) c.truncated = true;
    addMentions(c, command, pathFragments(word, spend));
    addLiteral(c, word.text);
  }
  // 無法分類的指令可能寫入工作目錄本身（`cd .note && python3 -c "open('x','w')"`）。
  if (effect.unclassified) addMentions(c, command, [{ text: '.', tilde: false }]);
  // heredoc 本文與 herestring 是承接指令的輸入：承接者是讀取類（cat、grep 等）時只是資料，
  // 否則（python3 -、sh、bash 等）可能就是程式，掃描其中的字面路徑（驗證 F-4）。
  const readOnly = effect.ops.length > 0 && effect.ops.every((op) => op === 'read');
  // 值無法確定的 word（`$'\uD800'` 等）出現在非讀取類指令：寫入目標無法判斷（P2-2）。
  if (!readOnly && command.words.some((w) => w.unresolved)) c.truncated = true;
  for (const redirect of command.redirects) {
    const word = redirect.target;
    if (word?.unresolved && redirect.kind !== 'read' && redirect.kind !== 'dupOrRead') {
      c.truncated = true;
    }
    if (redirect.kind === 'heredoc' || redirect.kind === 'herestring') {
      if (readOnly) continue;
      const texts = [redirect.body, redirect.kind === 'herestring' ? word?.text : undefined];
      for (const text of texts) {
        if (text === undefined) continue;
        addMentions(c, command, fragmentsOfText([text], spend));
        addLiteral(c, text);
      }
      continue;
    }
    const isDup = redirect.kind === 'dupOrWrite' || redirect.kind === 'dupOrRead';
    if (word === undefined || (isDup && FD_DUP.test(word.text))) continue;
    if (
      redirect.kind === 'read' ||
      redirect.kind === 'dupOrRead' ||
      redirect.kind === 'readWrite'
    ) {
      addOp(c, 'read', name);
    }
    if (redirect.kind === 'read' || redirect.kind === 'dupOrRead') continue;
    if (word.text.length === 0 || WRITE_GUARD_BASH_NON_WRITE_TARGETS.includes(word.text)) continue;
    addOp(c, 'edit', name);
    for (const t of underDirs(c, command, target([segmentOf(word)]))) push(c, c.targets, t);
    // `> "$(echo /w/.note/a)"`：展開後的值未知，但字面出現的路徑片段仍要檢查。
    if (word.expansion) addMentions(c, command, pathFragments(word, spend));
    addLiteral(c, word.text);
  }
}

/** 無法解析時的結果：三種操作類別都需要、寫入目標無法判斷（驗證 F-1）。 */
export const UNPARSEABLE_BASH: BashAnalysis = Object.freeze({
  ops: ['read', 'edit', 'delete'],
  opSources: {},
  targets: [],
  mentions: [],
  literalTexts: [],
  truncated: true,
  nestingExceeded: true,
}) as BashAnalysis;

/**
 * 分析一整段 Bash 指令字串。永不拋出：任何例外一律視為無法解析（UNPARSEABLE_BASH）；
 * 工作量預算用完時回傳同樣內容的另一個物件（測試可以區分兩者）。
 */
export function analyzeBash(command: string, options: AnalyzeOptions = {}): BashAnalysis {
  try {
    return analyzeParsed(command, options);
  } catch (err) {
    return err instanceof BashBudgetExceeded
      ? { ...UNPARSEABLE_BASH, ops: [...UNPARSEABLE_BASH.ops] }
      : UNPARSEABLE_BASH;
  }
}

function analyzeParsed(command: string, options: AnalyzeOptions): BashAnalysis {
  const budget = options.budget ?? new WorkBudget();
  const parsed = parseBash(command, budget);
  // zsh 的執行型展開（glob qualifier `(e:...:)`、`(+func)`、`${(e)x}` 等）：值與副作用都無法判斷。
  const zshUnsafe = hasZshExecExpansion(command);
  const unparseable = parsed.nestingExceeded || zshUnsafe;
  const c: Collector = {
    ops: new Set(),
    opSources: {},
    targets: [],
    mentions: [],
    literalTexts: [],
    truncated: parsed.dirsTruncated || unparseable,
    budget,
  };
  const platform = options.platform ?? process.platform;
  for (const simple of parsed.commands) collect(c, simple, platform);
  if (unparseable) {
    // 超過巢狀上限、結構無法配對或 zsh 執行型展開：可能藏著任何指令。沒有對應的指令片段。
    c.ops.add('edit');
    c.ops.add('delete');
  }
  return {
    ops: OPERATION_ORDER.filter((op) => c.ops.has(op)),
    opSources: c.opSources,
    targets: c.targets,
    mentions: c.mentions,
    literalTexts: c.literalTexts,
    truncated: c.truncated,
    nestingExceeded: unparseable,
  };
}
