/**
 * hook 端裁決的隨機故障注入（fuzz 風格，固定種子可重現）：每個 dep 隨機拋例外、
 * 工具與 session 隨機。不變量：runGuardedDelivery 永不拋出；最多輸出一則 deny JSON；
 * 輸出與記錄不含例外內容；未知 session 或 protectedRoots 為空時一律放行；
 * 已知 session 加 KB 啟用時，欄位抽取失敗的寫入類工具一律 deny、讀取類一律放行。
 */

import { describe, expect, it } from 'vitest';

import type { Faults } from './hookGuardFaultHarness.js';
import { deliver, listOf, SECRET, SESSION } from './hookGuardFaultHarness.js';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Read', 'Glob', 'Grep', 'WebFetch'];
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash'];

describe('fuzz: random faults in the hook-side check', () => {
  it('keeps every invariant over 600 random runs', async () => {
    const random = prng(1109);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    for (let n = 0; n < 600; n++) {
      const tool = pick(TOOLS);
      const known = random() < 0.7;
      const rootsOn = random() < 0.7;
      const faults: Faults = {
        extract: random() < 0.3,
        normalize: random() < 0.3,
        readList: random() < 0.15,
        request: random() < 0.3,
        emit: random() < 0.2,
        forward: random() < 0.1,
        unanswered: random() < 0.5,
        list: random() < 0.1 ? null : listOf(rootsOn ? ['/w/.note'] : [], [SESSION]),
      };
      const label = JSON.stringify({ n, tool, known, faults });
      const { emitted, logs } = await deliver(tool, faults, known ? SESSION : 'stranger');
      expect(emitted.length, label).toBeLessThanOrEqual(1);
      for (const output of [...emitted, ...logs]) expect(output, label).not.toContain(SECRET);
      for (const output of emitted) {
        expect(JSON.parse(output).hookSpecificOutput.permissionDecision, label).toBe('deny');
      }
      const effectiveList = faults.readList ? null : faults.list;
      const ruleActive =
        known && effectiveList !== null && effectiveList?.protectedRoots.length !== 0;
      if (!ruleActive) expect(emitted, label).toEqual([]);
      if (ruleActive && faults.extract) {
        expect(emitted.length, label).toBe(WRITE_TOOLS.includes(tool) ? 1 : 0);
      }
    }
  });
});
