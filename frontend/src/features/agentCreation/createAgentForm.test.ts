import { describe, expect, it } from 'vitest';

import { canCreateAgent, normalizeAgentPath } from './createAgentForm';

describe('createAgentForm', () => {
  it('工作空間沒有任何目錄時，輸入 Path 後即可建立', () => {
    expect(canCreateAgent('w1', '/Users/me/agent-a', false)).toBe(true);
  });

  it('Path 為空或只有空白時不能建立', () => {
    expect(canCreateAgent('w1', '', false)).toBe(false);
    expect(canCreateAgent('w1', '   ', false)).toBe(false);
  });

  it('沒有選工作空間或請求進行中時不能建立', () => {
    expect(canCreateAgent('', '/Users/me/agent-a', false)).toBe(false);
    expect(canCreateAgent('w1', '/Users/me/agent-a', true)).toBe(false);
  });

  it('送出的 Path 會去掉前後空白', () => {
    expect(normalizeAgentPath('  /Users/me/agent-a \n')).toBe('/Users/me/agent-a');
  });
});
