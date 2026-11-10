/**
 * 個人 KB 識別鍵與保留鍵（P2 驗收 3 的純函式部分）。
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { KB_PERSONAL_RESERVED_KEY, ROLE_ID_PATTERN } from '../src/constants.js';
import { isValidRoleId } from '../src/roles.js';
import { personalKbKey, personalKbOwnRoot } from '../src/writeGuard/kbIdentity.js';

describe('personal KB identity key', () => {
  it('uses the roleId for a valid Role and the reserved key without one', () => {
    expect(personalKbKey('writer.md')).toBe('writer.md');
    expect(personalKbKey(undefined)).toBe(KB_PERSONAL_RESERVED_KEY);
  });

  it('refuses a roleId with ../, separators, NUL or outside the allowlist', () => {
    for (const bad of [
      '../x.md',
      '..',
      'a/b.md',
      'a\\b.md',
      'x\0.md',
      '.hidden.md',
      'noext',
      'CON.md',
      '',
      'x'.repeat(70) + '.md',
    ]) {
      expect(personalKbKey(bad), bad).toBeNull();
    }
  });

  it('the reserved key can never be a valid Role file name, in any case', () => {
    expect(ROLE_ID_PATTERN.test(KB_PERSONAL_RESERVED_KEY)).toBe(false);
    expect(isValidRoleId(KB_PERSONAL_RESERVED_KEY)).toBe(false);
    expect(isValidRoleId(KB_PERSONAL_RESERVED_KEY.toUpperCase())).toBe(false);
    expect(isValidRoleId(`${KB_PERSONAL_RESERVED_KEY}.md`)).toBe(false);
    expect(isValidRoleId('default.md')).toBe(true);
    expect(personalKbKey('default.md')).not.toBe(KB_PERSONAL_RESERVED_KEY);
  });

  it('same Directory and Role give the same path; different Roles differ', () => {
    const dir = '/home/me/proj';
    const a = personalKbOwnRoot(dir, personalKbKey('a.md')!);
    const b = personalKbOwnRoot(dir, personalKbKey('b.md')!);
    expect(a).toBe(path.join(dir, '.note', 'a.md'));
    expect(a).not.toBe(b);
    // 「重啟後」同 Directory 同角色：純函式，結果只取決於這兩個輸入。
    expect(personalKbOwnRoot(dir, personalKbKey('a.md')!)).toBe(a);
    expect(personalKbOwnRoot(dir, personalKbKey(undefined)!)).toBe(
      path.join(dir, '.note', KB_PERSONAL_RESERVED_KEY),
    );
  });
});
