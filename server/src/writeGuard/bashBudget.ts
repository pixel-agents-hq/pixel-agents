/**
 * Bash 分析的確定性工作量預算（P3，第二次驗證 P1-1）。不看時鐘：計數 lexer 的迴圈與
 * 讀過的字元、parser 的指令、analysis 的路徑片段。用完時拋 BashBudgetExceeded，
 * analyzeBash 把它視為無法解析（read、edit、delete，unresolved）。
 */

import { WRITE_GUARD_BASH_MAX_WORK } from '../constants.js';

export class BashBudgetExceeded extends Error {
  constructor() {
    super('bash analysis budget exceeded');
  }
}

export class WorkBudget {
  private remaining: number;

  constructor(units: number = WRITE_GUARD_BASH_MAX_WORK) {
    this.remaining = units;
  }

  spend(units = 1): void {
    this.remaining -= units;
    if (this.remaining < 0) throw new BashBudgetExceeded();
  }
}
