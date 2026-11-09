/**
 * `case ... in pat) cmds ;; esac` 的斷詞狀態（P3，驗證 F-6）。純函式。
 *
 * 樣式結尾的 `)` 不是括號：若不處理，`$(case a in a) touch x;; esac)` 的命令替換會在
 * 樣式的 `)` 提早結束，`touch` 落到外層變成 echo 的參數而被漏掉。這裡把：
 * - `case` 換成 null 指令 `:`（主詞成為它的參數，其中的命令替換仍會解析）；
 * - `in`、`;;`／`;&`／`;;&` 之後進入樣式狀態：先插入 `;` 與 `:`，樣式 word 成為 `:` 的參數，
 *   樣式中的 `|`、開頭的 `(`、換行略過；
 * - 樣式結尾的 `)` 換成 `;`，之後是一般指令；
 * - `esac` 結束這一層（巢狀 case 用堆疊）。
 * 斷詞結束時堆疊不為空（case 沒有配對）：呼叫端視為無法解析。
 */

import { isKeyword, nullCommandWord } from './bashKeywords.js';
import type { BashToken, BashWord } from './bashTypes.js';

type CaseState = 'subject' | 'pattern' | 'body';

const SEMI: BashToken = { kind: 'op', op: ';' };
const CASE_ITEM_ENDS = [';;', ';&', ';;&'];

export class CaseTracker {
  private readonly stack: CaseState[] = [];

  get open(): boolean {
    return this.stack.length > 0;
  }

  /** 樣式狀態中（`(` 是樣式開頭，不是算術或子殼層）。 */
  get inPattern(): boolean {
    return this.top === 'pattern';
  }

  private get top(): CaseState | undefined {
    return this.stack[this.stack.length - 1];
  }

  private set top(state: CaseState) {
    this.stack[this.stack.length - 1] = state;
  }

  /** 一個 word 要輸出的 token（可能被取代或加上前綴）。 */
  onWord(word: BashWord, atCommandStart: boolean): BashToken[] {
    const plain: BashToken = { kind: 'word', word };
    const top = this.top;
    if (top === 'subject') {
      if (!isKeyword(word, 'in')) return [plain];
      this.top = 'pattern';
      return [SEMI, { kind: 'word', word: nullCommandWord() }];
    }
    if (top === 'pattern') {
      if (!isKeyword(word, 'esac')) return [plain];
      this.stack.pop();
      return [SEMI];
    }
    if (top === 'body' && atCommandStart && isKeyword(word, 'esac')) {
      this.stack.pop();
      return [SEMI];
    }
    if (atCommandStart && isKeyword(word, 'case')) {
      this.stack.push('subject');
      return [{ kind: 'word', word: nullCommandWord() }];
    }
    return [plain];
  }

  /** `)`：樣式結尾時回傳取代的 token，否則 null（一般括號）。 */
  onCloseParen(): BashToken[] | null {
    if (this.top !== 'pattern') return null;
    this.top = 'body';
    return [SEMI];
  }

  /** `(`：樣式開頭可選的 `(` 略過。 */
  onOpenParen(): BashToken[] | null {
    return this.top === 'pattern' ? [] : null;
  }

  /** 運算子原文（未換成 `;` 之前）。 */
  onOperator(text: string): BashToken[] | null {
    if (this.top === 'body' && CASE_ITEM_ENDS.includes(text)) {
      this.top = 'pattern';
      return [SEMI, { kind: 'word', word: nullCommandWord() }];
    }
    if (this.top === 'pattern' && (text === '|' || text === ';')) return [];
    return null;
  }

  /** 換行：主詞與樣式狀態中略過（否則樣式會變成新指令的名稱）。 */
  onNewline(): BashToken[] | null {
    return this.top === 'pattern' || this.top === 'subject' ? [] : null;
  }
}
