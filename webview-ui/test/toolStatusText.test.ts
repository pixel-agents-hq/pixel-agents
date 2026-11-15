/**
 * Tool statuses re-worded for display: known English prefixes translated with
 * their variable part kept, anything else passed through.
 */

import { describe, expect, it } from 'vitest';

import type { MessageKey, MessageVars } from '../src/i18n/index.js';
import { translate } from '../src/i18n/index.js';
import { localizeToolStatus } from '../src/office/toolStatusText.js';

const vi = (key: MessageKey, vars?: MessageVars) => translate('vi', key, vars);
const en = (key: MessageKey, vars?: MessageVars) => translate('en', key, vars);

describe('localizeToolStatus', () => {
  it('translates prefixed statuses, keeping the variable part', () => {
    expect(localizeToolStatus('Reading foo.ts', vi)).toBe('Đang đọc foo.ts');
    expect(localizeToolStatus('Running: npm test', vi)).toBe('Đang chạy: npm test');
    expect(localizeToolStatus('Subtask: Find {bugs}', vi)).toBe('Tác vụ con: Find {bugs}');
    expect(localizeToolStatus('Using MyTool', vi)).toBe('Đang dùng MyTool');
  });

  it('prefers exact statuses over prefixes', () => {
    expect(localizeToolStatus('Editing notebook', vi)).toBe('Đang sửa notebook');
    expect(localizeToolStatus('Running subtask', vi)).toBe('Đang chạy tác vụ con');
    expect(localizeToolStatus('Searching code', vi)).toBe('Đang tìm mã');
  });

  it('is the identity in English', () => {
    for (const s of ['Reading a.ts', 'Running: ls', 'Searching the web', 'Creating team: x']) {
      expect(localizeToolStatus(s, en)).toBe(s);
    }
  });

  it('passes unrecognized text through', () => {
    expect(localizeToolStatus('-> alice', vi)).toBe('-> alice');
    expect(localizeToolStatus('Doing something new', vi)).toBe('Doing something new');
  });
});
