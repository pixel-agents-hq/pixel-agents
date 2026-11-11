import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { KB_REJECTION_TEXT, KB_TEXT } from '../../constants';
import { EMPTY_KB_VIEW } from '../../features/kb/kbSlice';
import type { KbView } from '../../features/kb/kbSlice';
import type { KbRejectionReason } from '../../protocol';
import { KbBrowser } from './KbBrowser';
import { joinDirectory, listDirectory, parentDirectory } from './kbTree';

const noop = () => {};
const view = (patch: Partial<KbView>): KbView => ({
  ...EMPTY_KB_VIEW,
  listed: true,
  files: [{ path: 'a.md', size: 1 }],
  ...patch,
});
const render = (v: KbView, extra: { blockedNote?: string } = {}) =>
  renderToStaticMarkup(<KbBrowser view={v} onSelect={noop} onChangeDirectory={noop} {...extra} />);

describe('KbBrowser', () => {
  it('內容與檔名當純文字輸出，不產生 HTML 標籤', () => {
    const html = render(
      view({
        files: [{ path: 'dir/<img src=x onerror=alert(1)>.md', size: 1 }],
        dir: 'dir',
        selectedPath: 'dir/<img src=x onerror=alert(1)>.md',
        content: '<img src=x onerror=alert(1)>',
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('工作空間沒有根目錄時顯示說明', () => {
    expect(render(EMPTY_KB_VIEW, { blockedNote: KB_TEXT.noRoot })).toContain('尚未設定根目錄');
  });

  it.each(Object.keys(KB_REJECTION_TEXT) as KbRejectionReason[])(
    '拒絕原因 %s 顯示對應說明',
    (reason) => {
      const expected = renderToStaticMarkup(<>{KB_REJECTION_TEXT[reason]}</>);
      expect(render(view({ listError: reason }))).toContain(expected);
      expect(render(view({ selectedPath: 'a.md', readError: reason }))).toContain(expected);
    },
  );

  it('資料夾名稱當純文字輸出', () => {
    const html = render(view({ files: [{ path: '<img src=x onerror=alert(1)>/a.md', size: 1 }] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;/');
  });

  it('根目錄只列這一層，沒有 .. 也沒有 .', () => {
    const html = render(
      view({
        files: [
          { path: 'notes/deep/x.md', size: 1 },
          { path: 'top.md', size: 1 },
        ],
      }),
    );
    expect(html).toContain('notes/');
    expect(html).toContain('top.md');
    expect(html).not.toContain('deep');
    expect(html).not.toContain('x.md');
    expect(html).not.toContain('>..<');
    expect(html).not.toContain('>.<');
    expect(html).toContain(`${KB_TEXT.location}：/<`);
  });

  it('進入資料夾後顯示 .. 與該層內容，從不顯示 .', () => {
    const html = render(
      view({
        files: [
          { path: 'notes/deep/x.md', size: 1 },
          { path: 'notes/n.md', size: 1 },
          { path: 'top.md', size: 1 },
        ],
        dir: 'notes',
      }),
    );
    expect(html).toContain('>..<');
    expect(html).not.toContain('>.<');
    expect(html).toContain('deep/');
    expect(html).toContain('n.md');
    expect(html).not.toContain('top.md');
    expect(html).toContain(`${KB_TEXT.location}：/notes<`);
  });

  it('選檔前不顯示內容，選檔後才顯示', () => {
    const files = [{ path: 'a.md', size: 1 }];
    const before = render(view({ files, content: 'SECRET' }));
    expect(before).toContain(KB_TEXT.pickFile);
    expect(before).not.toContain('SECRET');
    const after = render(view({ files, selectedPath: 'a.md', content: 'SECRET' }));
    expect(after).toContain('SECRET');
  });
});

describe('listDirectory', () => {
  const paths = [
    'b.md',
    'a/z.md',
    'a/deep/q.md',
    'ab.md',
    'a.md',
    'ab/c.md',
    '中文/筆記.md',
    '中文/子/二.md',
  ];

  it('根目錄：資料夾在前、各自排序，只有更深檔案的資料夾也會出現', () => {
    expect(listDirectory(paths, '').map((e) => `${e.kind}:${e.name}`)).toEqual([
      'folder:中文',
      'folder:a',
      'folder:ab',
      'file:a.md',
      'file:ab.md',
      'file:b.md',
    ]);
  });

  it('巢狀目錄與相似前綴不混淆', () => {
    expect(listDirectory(paths, 'a')).toEqual([
      { kind: 'folder', name: 'deep', path: 'a/deep' },
      { kind: 'file', name: 'z.md', path: 'a/z.md' },
    ]);
    expect(listDirectory(paths, 'ab')).toEqual([{ kind: 'file', name: 'c.md', path: 'ab/c.md' }]);
    expect(listDirectory(['a/deep/q.md'], 'a')).toEqual([
      { kind: 'folder', name: 'deep', path: 'a/deep' },
    ]);
  });

  it('中文路徑', () => {
    expect(listDirectory(paths, '中文')).toEqual([
      { kind: 'folder', name: '子', path: '中文/子' },
      { kind: 'file', name: '筆記.md', path: '中文/筆記.md' },
    ]);
  });

  it('空清單與不存在的目錄', () => {
    expect(listDirectory([], '')).toEqual([]);
    expect(listDirectory(paths, 'nope')).toEqual([]);
  });

  it('parentDirectory / joinDirectory', () => {
    expect(parentDirectory('a/b')).toBe('a');
    expect(parentDirectory('a')).toBe('');
    expect(parentDirectory('')).toBe('');
    expect(joinDirectory('', 'a')).toBe('a');
    expect(joinDirectory('a', 'b')).toBe('a/b');
  });
});
