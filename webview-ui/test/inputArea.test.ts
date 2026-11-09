/** Where a long press on the terminal offers Paste: the prompt box around the cursor. */

import { describe, expect, it } from 'vitest';

import { inputAreaRows, isRuleRow } from '../src/terminal/inputArea.js';

const RULE = '─'.repeat(40);

describe('input area', () => {
  it('spans the rules around the cursor, rules included', () => {
    const screen = [
      '● Done.',
      '',
      RULE,
      '> fix the bug',
      '  and test it',
      RULE,
      '  ? for shortcuts',
    ];
    expect(inputAreaRows((r) => screen[r], 4)).toEqual({ startRow: 2, endRow: 5 });
  });

  it('recognizes the older rounded box', () => {
    const screen = [
      `╭${'─'.repeat(30)}╮`,
      '│ > hi                          │',
      `╰${'─'.repeat(30)}╯`,
    ];
    expect(inputAreaRows((r) => screen[r], 1)).toEqual({ startRow: 0, endRow: 2 });
  });

  it('is the cursor row alone without a rule on both sides', () => {
    const screen = ['$ ls', 'a b c', '$ '];
    expect(inputAreaRows((r) => screen[r], 2)).toEqual({ startRow: 2, endRow: 2 });
  });

  it('a line of text with a few dashes is no rule', () => {
    expect(isRuleRow('see ── the docs ── here for more about this')).toBe(false);
    expect(isRuleRow('──')).toBe(false);
    expect(isRuleRow(`  ${RULE}  `)).toBe(true);
  });
});
