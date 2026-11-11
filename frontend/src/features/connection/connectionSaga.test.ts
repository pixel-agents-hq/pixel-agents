import { describe, expect, it } from 'vitest';

import { buildSocketUrl, reconnectDelayMs } from './connectionSaga';

describe('buildSocketUrl', () => {
  it('https 使用 wss', () => {
    expect(buildSocketUrl({ protocol: 'https:', host: 'a.test' })).toBe('wss://a.test/ws');
  });

  it('http 使用 ws', () => {
    expect(buildSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws',
    );
  });
});

describe('reconnectDelayMs', () => {
  it('逐步拉長並停在最後一格', () => {
    expect([0, 1, 4, 99].map(reconnectDelayMs)).toEqual([250, 500, 4000, 4000]);
  });
});
