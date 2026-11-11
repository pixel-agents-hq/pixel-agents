import { describe, expect, it } from 'vitest';

import { AGENT_CREATED_NOTICE, noticeFrom, noticeState } from './creationNotice';

describe('creationNotice', () => {
  it('導覽狀態帶的成功訊息可以取回', () => {
    expect(noticeFrom(noticeState(AGENT_CREATED_NOTICE))).toBe(AGENT_CREATED_NOTICE);
  });

  it('沒有狀態、形狀不對或空字串時視為沒有訊息', () => {
    expect(noticeFrom(null)).toBeNull();
    expect(noticeFrom(undefined)).toBeNull();
    expect(noticeFrom('x')).toBeNull();
    expect(noticeFrom({})).toBeNull();
    expect(noticeFrom({ notice: 7 })).toBeNull();
    expect(noticeFrom({ notice: '' })).toBeNull();
  });
});
