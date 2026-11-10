import { describe, expect, it } from 'vitest';

import { buildSocketUrl, reconnectDelayMs } from './connectionSaga';

describe('buildSocketUrl', () => {
  it('https 使用 wss，並把 token 放進查詢字串', () => {
    expect(buildSocketUrl({ protocol: 'https:', host: 'a.test' }, 'x y')).toBe(
      'wss://a.test/ws?token=x%20y',
    );
  });

  it('沒有 token 時不加查詢字串', () => {
    expect(buildSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, null)).toBe(
      'ws://localhost:5173/ws',
    );
  });
});

describe('reconnectDelayMs', () => {
  it('逐步拉長並停在最後一格', () => {
    expect([0, 1, 4, 99].map(reconnectDelayMs)).toEqual([250, 500, 4000, 4000]);
  });
});
