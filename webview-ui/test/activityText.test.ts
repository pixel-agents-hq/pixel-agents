import { describe, expect, it } from 'vitest';

import { getActivityText } from '../src/office/activityText.js';

describe('live activity labels', () => {
  it('shows generation as working, not idle or a completed tool', () => {
    expect(getActivityText(1, {}, true, null, false)).toBe('Working');
    expect(
      getActivityText(
        1,
        { 1: [{ toolId: 'a', status: 'Researching the web', done: true }] },
        true,
        null,
        false,
      ),
    ).toBe('Working');
    expect(getActivityText(1, {}, false, null, false)).toBe('Idle');
  });
  it('prioritizes live tool activity and approval states', () => {
    const tools = { 1: [{ toolId: 'a', status: 'Running a command', done: false }] };
    expect(getActivityText(1, tools, true, null, false)).toBe('Running a command');
    expect(getActivityText(1, tools, true, 'permission', false)).toBe('Needs approval');
    expect(getActivityText(1, {}, false, 'waiting', true)).toBe('Waiting for input');
    expect(getActivityText(1, {}, true, 'waiting', true)).toBe('Working');
  });
});
