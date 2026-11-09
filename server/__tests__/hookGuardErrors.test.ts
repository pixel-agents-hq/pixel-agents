/**
 * hook 端裁決流程的例外一律走統一的 fail-closed 判斷（P3，與驗證 F-1 同根因）。
 * 以注入讓 FieldExtractor、PathNormalizer、清單讀取、裁決請求、輸出分別拋例外。
 * 不碰網路、不呼叫真實 claude。
 */

import { describe, expect, it } from 'vitest';

import { WRITE_GUARD_DENY_TEMPLATES, WRITE_GUARD_RULE_GUARD_ERROR } from '../src/constants.js';
import { renderDenyMessage } from '../src/writeGuard/denyMessage.js';
import { deliver, listOf, SECRET, SERVER, SESSION } from './hookGuardFaultHarness.js';

const GUARD_ERROR_REASON = renderDenyMessage(WRITE_GUARD_RULE_GUARD_ERROR, undefined, []);
const reasonOf = (output: string): string =>
  (JSON.parse(output) as { hookSpecificOutput: { permissionDecisionReason: string } })
    .hookSpecificOutput.permissionDecisionReason;

describe('an exception anywhere in the hook-side check fails closed for writes', () => {
  it.each(['extract', 'normalize', 'request'] as const)(
    '%s throws: Write, Edit, NotebookEdit and Bash are denied with the guard-error template',
    async (fault) => {
      for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
        // normalize 對 Bash 的失敗在 Bash 分析內部被吸收為「無法解析」：請求帶 unresolved 交給
        // 伺服器（KB 啟用時伺服器 deny）；這裡以伺服器不回答驗證 hook 本地同樣 fail-closed。
        const absorbed = fault === 'normalize' && tool === 'Bash';
        const { emitted, logs } = await deliver(tool, { [fault]: true, unanswered: absorbed });
        expect(emitted, `${fault} ${tool}`).toHaveLength(1);
        const reason = reasonOf(emitted[0]);
        if (!absorbed) expect(reason).toBe(GUARD_ERROR_REASON);
        expect(reason).not.toContain(SECRET);
        expect(reason).not.toMatch(/\bat \S+:\d+/);
        expect(logs.join('\n')).not.toContain(SECRET);
      }
    },
  );

  it('the template is fixed text and carries no path', () => {
    expect(GUARD_ERROR_REASON).toContain(
      WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_GUARD_ERROR].reason,
    );
    expect(GUARD_ERROR_REASON).not.toContain('Path:');
  });

  it('read tools stay allowed when the check throws', async () => {
    for (const fault of ['extract', 'normalize', 'request'] as const) {
      expect((await deliver('Read', { [fault]: true })).emitted, fault).toEqual([]);
    }
  });

  it('unknown session, empty protectedRoots and a corrupt list (null) are allowed', async () => {
    expect((await deliver('Write', { extract: true }, 'someone-else')).emitted).toEqual([]);
    expect(
      (await deliver('Write', { extract: true, list: listOf([], [SESSION]) })).emitted,
    ).toEqual([]);
    expect((await deliver('Write', { extract: true, list: null })).emitted).toEqual([]);
  });

  it('a throwing list read means "cannot tell": allowed and logged', async () => {
    for (const tool of ['Write', 'Bash', 'Read']) {
      const { emitted, logs } = await deliver(tool, { readList: true });
      expect(emitted, tool).toEqual([]);
      expect(logs).toContain(`guard-error stage=list port=${SERVER.port}`);
    }
  });

  it('a throwing emit or forward never throws out and emits at most once', async () => {
    const failedEmit = await deliver('Write', { extract: true, emit: true });
    expect(failedEmit.emitted).toHaveLength(1);
    expect(failedEmit.logs).toContain('guard-error stage=emit');
    const failedForward = await deliver('Write', { extract: true, forward: true });
    expect(failedForward.emitted).toHaveLength(1);
  });
});
