import { describe, expect, it } from 'vitest';

import {
  backgroundIds,
  backgroundInfoOf,
  kindTransition,
  officeAgentIds,
  withoutKey,
  withTitle,
  withTitles,
} from '../src/hooks/agentKindState.js';

describe('withTitle', () => {
  it('sets a trimmed title', () => {
    expect(withTitle({}, 3, '  Draft review by email ')).toEqual({ 3: 'Draft review by email' });
  });

  it('replaces the previous title (newest wins)', () => {
    expect(withTitle({ 3: 'Old' }, 3, 'New')).toEqual({ 3: 'New' });
  });

  it('keeps identity when nothing changes, so React skips the render', () => {
    const titles = { 3: 'Same' };
    expect(withTitle(titles, 3, 'Same')).toBe(titles);
    expect(withTitle(titles, 9, undefined)).toBe(titles);
  });

  it('clears on a blank or non-string title', () => {
    expect(withTitle({ 3: 'Old', 4: 'Keep' }, 3, '  ')).toEqual({ 4: 'Keep' });
    expect(withTitle({ 3: 'Old' }, 3, 42)).toEqual({});
  });
});

describe('withTitles', () => {
  it('merges a snapshot keyed by JSON string ids', () => {
    expect(withTitles({ 1: 'Keep' }, { '2': 'Fix CI', '3': 'Write docs' })).toEqual({
      1: 'Keep',
      2: 'Fix CI',
      3: 'Write docs',
    });
  });

  it('ignores junk and blank entries, and a missing snapshot', () => {
    const titles = { 1: 'Keep' };
    expect(withTitles(titles, undefined)).toBe(titles);
    expect(withTitles(titles, { x: 'nope', '2': '', '3': 7 })).toBe(titles);
  });
});

describe('withoutKey', () => {
  it('drops the key, or returns the same record when it is absent', () => {
    const record = { 1: 'a', 2: 'b' };
    expect(withoutKey(record, 1)).toEqual({ 2: 'b' });
    expect(withoutKey(record, 5)).toBe(record);
  });
});

describe('backgroundIds', () => {
  it('collects only ids flagged true', () => {
    expect([...backgroundIds({ '4': true, '5': false, '6': true, bad: true })]).toEqual([4, 6]);
  });

  it('is empty for a snapshot without the field', () => {
    expect(backgroundIds(undefined).size).toBe(0);
  });
});

describe('kindTransition', () => {
  it('turns a character into a worker, and back', () => {
    expect(kindTransition(false, true)).toBe('toWorker');
    expect(kindTransition(true, false)).toBe('toCharacter');
  });

  it('does nothing on a repeat report', () => {
    expect(kindTransition(true, true)).toBe('none');
    expect(kindTransition(false, false)).toBe('none');
  });
});

describe('backgroundInfoOf', () => {
  it('keeps what the character needs to come back as itself', () => {
    expect(
      backgroundInfoOf({
        palette: 2,
        hueShift: 90,
        seatId: 'chair-1',
        directoryName: 'hobbyfi-blog',
        isHeadless: true,
      }),
    ).toEqual({
      palette: 2,
      hueShift: 90,
      seatId: 'chair-1',
      directoryName: 'hobbyfi-blog',
      isHeadless: true,
    });
  });

  it('drops absent parts (no seat, not headless)', () => {
    expect(backgroundInfoOf({ palette: 0, hueShift: 0, seatId: null })).toEqual({
      palette: 0,
      hueShift: 0,
    });
    expect(backgroundInfoOf(undefined)).toEqual({});
  });
});

describe('officeAgentIds', () => {
  it('leaves the background agents out, keeping the order', () => {
    expect(officeAgentIds([1, 2, 3, 4], { 2: {}, 4: { directoryName: 'x' } })).toEqual([1, 3]);
  });
});
