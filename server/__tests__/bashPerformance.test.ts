/**
 * P3 第二次驗證 P1-1：病態輸入的分析時間有確定性上限（工作量預算），hook 端另有時鐘防線。
 * 200 KB 的各種病態輸入在 hook 端 planBash 都要遠小於 1 秒，且結果為無法判斷。
 */

import * as os from 'os';
import { describe, expect, it } from 'vitest';

import { WRITE_GUARD_BASH_LOCAL_DEADLINE_MS } from '../src/constants.js';
import { planBash } from '../src/providers/hook/claude/guard/bashPlan.js';
import { analyzeBash } from '../src/writeGuard/bashAnalysis.js';
import { pathNormalizer } from '../src/writeGuard/pathNormalization.js';

const SIZE = 200_000;
const PATHOLOGICAL: Array<[string, string]> = [
  ['one long word after a dash', `python3 -${'a'.repeat(SIZE)}`],
  ['a long attached option value', `curl -o${'a/'.repeat(SIZE / 2)} u`],
  ['many words', `node ${'a '.repeat(SIZE / 2)}`],
  ['many path fragments', `python3 -c "${'a/b,'.repeat(SIZE / 4)}"`],
  ['repeated operators', `${';'.repeat(SIZE)}rm x`],
  ['repeated &&', `${'true && '.repeat(SIZE / 8)}rm x`],
  ['deep nesting', `${'('.repeat(SIZE / 2)}rm x${')'.repeat(SIZE / 2)}`],
  ["many $'\\x41' escapes", `touch $'${'\\x41'.repeat(SIZE / 4)}'`],
  ['a long heredoc for an interpreter', `python3 - <<'EOF'\n${'x = 1\n'.repeat(SIZE / 6)}EOF`],
  ['many redirects', `echo ${'>a '.repeat(SIZE / 3)}`],
];

describe('bounded analysis time (P1-1)', () => {
  it.each(PATHOLOGICAL)('%s: planBash is fast and unresolved', (_label, command) => {
    const started = performance.now();
    const plan = planBash(command, '/tmp', os.homedir(), pathNormalizer);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(plan.unresolved).toBe(true);
  });

  it('the work budget, not the clock, ends the analysis (deterministic)', () => {
    const command = `python3 -${'a'.repeat(SIZE)}`;
    expect(analyzeBash(command).ops).toEqual(['read', 'edit', 'delete']);
    expect(analyzeBash(command).truncated).toBe(true);
  });

  it('the hook-side clock guard gives up past the deadline', () => {
    let t = 0;
    const clock = () => {
      t += WRITE_GUARD_BASH_LOCAL_DEADLINE_MS;
      return t;
    };
    const plan = planBash('touch /tmp/a', '/tmp', os.homedir(), pathNormalizer, clock);
    expect(plan).toMatchObject({ unresolved: true, ops: ['read', 'edit', 'delete'] });
    expect(planBash('touch /tmp/a', '/tmp', os.homedir(), pathNormalizer).unresolved).toBe(false);
  });

  it.each([40_000, 100_000])(
    "verifier repro: analyzeBash('python3 -' + 'a' x %i) and planBash stay fast",
    (n) => {
      const command = `python3 -${'a'.repeat(n)}`;
      const started = performance.now();
      analyzeBash(command);
      planBash(command, '/tmp', os.homedir(), pathNormalizer);
      expect(performance.now() - started).toBeLessThan(500);
    },
  );

  it('ordinary commands are unaffected by the budget', () => {
    const script = `python3 - <<'EOF'\n${'print(1)\n'.repeat(2000)}EOF`;
    expect(analyzeBash(script).truncated).toBe(false);
  });
});
