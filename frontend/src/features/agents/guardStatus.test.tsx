import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GuardStatusPanel } from '../../components/GuardStatusPanel';
import { GUARD_TEXT } from '../../constants';
import type { GuardInactiveReason } from '../../protocol';
import { buildGuardStatus } from './guardStatus';

const render = (active: boolean, reasons: string[], root?: string, curator: string | null = null) =>
  renderToStaticMarkup(
    <GuardStatusPanel
      status={buildGuardStatus(
        { active, reasons: reasons as GuardInactiveReason[], permissionRoles: null },
        root,
        curator,
      )}
    />,
  );

describe('guard 狀態三條線', () => {
  it('active 但沒有根目錄時不宣稱生效中', () => {
    const html = render(true, ['no_workspace_root']);
    expect(html).not.toContain('生效中');
    expect(html).not.toContain(GUARD_TEXT.summary);
    expect(html).toContain(GUARD_TEXT.rulesOff);
    expect(html).toContain(GUARD_TEXT.hookVerified);
  });

  it('沒有根目錄也沒有寫入者時，伺服器不會送 no_curator，寫入者行不得宣稱已指定', () => {
    const html = render(true, ['no_workspace_root'], undefined, null);
    expect(html).toContain(GUARD_TEXT.curatorUnassigned);
    expect(html).not.toContain('已指定');
    expect(html).not.toContain(GUARD_TEXT.curatorNone);
  });

  it('沒有根目錄但已有寫入者時顯示寫入者名稱', () => {
    expect(render(true, ['no_workspace_root'], undefined, 'writer')).toContain('writer');
  });

  it('active 且有根目錄才顯示 KB 寫入保護生效中，並列出根目錄', () => {
    const html = render(true, [], '/work/root', 'writer');
    expect(html).toContain(GUARD_TEXT.summary);
    expect(html).toContain('/work/root');
    expect(html).toContain('writer');
  });

  it('沒有 KB Writer 時顯示已鎖定', () => {
    expect(render(true, ['no_curator'], '/r')).toContain('已鎖定');
  });

  it('只有 awaiting_first_verdict 顯示尚未驗證，且不宣稱已驗證', () => {
    const html = render(false, ['awaiting_first_verdict']);
    expect(html).toContain('尚未驗證');
    expect(html).not.toContain(GUARD_TEXT.hookVerified);
  });

  it('hook 缺失顯示未運作', () => {
    expect(render(false, ['pretooluse_hook_missing'])).toContain(GUARD_TEXT.hookBroken);
  });

  it('沒看過的原因代碼顯示原文', () => {
    const html = render(false, ['brand_new_reason']);
    expect(html).toContain('brand_new_reason');
    expect(html).not.toContain('undefined');
  });

  it('伺服器字串當純文字輸出', () => {
    const html = render(true, [], '/x/<img src=x onerror=alert(1)>', '<b>n</b>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
  });
});
