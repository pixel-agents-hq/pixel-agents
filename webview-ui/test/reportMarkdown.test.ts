/**
 * The report's markdown reader (phase M): the shapes it understands, and its
 * safety — it returns data, never HTML, so markup stays text; and a link is a
 * link only for an absolute http(s) URL.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { Block, Inline } from '../src/tasks/reportMarkdown.js';
import {
  inlineText,
  parseInline,
  parseMarkdown,
  safeLinkHref,
} from '../src/tasks/reportMarkdown.js';

/** Every inline node in a block tree, depth first. */
function allInlines(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.type === 'bold' || n.type === 'italic' || n.type === 'link') walk(n.children);
    }
  };
  for (const b of blocks) {
    if (b.type === 'list') b.items.forEach(walk);
    else walk(b.children);
  }
  return out;
}

describe('parseMarkdown', () => {
  it('headings, lists and paragraphs', () => {
    const blocks = parseMarkdown(
      [
        '# Daily report',
        '',
        '## Done today',
        '- Shipped the **Tasks board**',
        '- Fixed a bug',
        '',
        '1. First',
        '2. Second',
        'Some advice',
        'over two lines.',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'heading', 'list', 'list', 'paragraph']);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });
    const bullets = blocks[2] as Extract<Block, { type: 'list' }>;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items.map(inlineText)).toEqual(['Shipped the Tasks board', 'Fixed a bug']);
    expect(bullets.items[0][1]).toMatchObject({ type: 'bold' });
    expect((blocks[3] as Extract<Block, { type: 'list' }>).ordered).toBe(true);
    expect(inlineText((blocks[4] as Extract<Block, { type: 'paragraph' }>).children)).toBe(
      'Some advice over two lines.',
    );
  });

  it('inline: bold, italic, code, http(s) links', () => {
    const nodes = parseInline('**PR** *now* `npm test` [#12](https://github.com/o/r/pull/12)');
    expect(nodes.map((n) => n.type)).toEqual([
      'bold',
      'text',
      'italic',
      'text',
      'code',
      'text',
      'link',
    ]);
    expect(nodes[6]).toMatchObject({ href: 'https://github.com/o/r/pull/12' });
    expect(inlineText(nodes)).toBe('PR now npm test #12');
  });

  it('snake_case stays text; CRLF reports parse the same', () => {
    expect(parseInline('fix my_var_name now')).toEqual([
      { type: 'text', text: 'fix my_var_name now' },
    ]);
    expect(parseMarkdown('# A\r\n- b\r\n')).toEqual(parseMarkdown('# A\n- b\n'));
    // A rule just separates blocks.
    expect(parseMarkdown('one\n---\ntwo').map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('safety', () => {
  it('HTML stays text: there is no HTML node, only text the renderer escapes', () => {
    const md = '# <img src=x onerror=alert(1)>\n- <script>alert(1)</script>\n<b>hi</b>';
    const nodes = allInlines(parseMarkdown(md));
    expect(nodes.every((n) => ['text', 'bold', 'italic', 'code', 'link'].includes(n.type))).toBe(
      true,
    );
    const text = nodes.map((n) => (n.type === 'text' ? n.text : '')).join('|');
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(nodes.some((n) => n.type === 'link')).toBe(false);
  });

  it('only absolute http(s) URLs become links; the rest keep just their text', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      '/relative/path',
      'file:///etc/passwd',
    ]) {
      const nodes = parseInline(`[click](${url})`);
      expect(nodes).toEqual([{ type: 'text', text: 'click' }]);
    }
    expect(parseInline('[ok](http://example.com/a)')[0]).toMatchObject({
      type: 'link',
      href: 'http://example.com/a',
    });
  });

  it('safeLinkHref', () => {
    expect(safeLinkHref('https://x.dev/p?q=1')).toBe('https://x.dev/p?q=1');
    expect(safeLinkHref(' http://x.dev ')).toBe('http://x.dev');
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('not a url')).toBeNull();
  });
});

describe('nested lists', () => {
  it('nests indented items under the item above, any depth', () => {
    const [list] = parseMarkdown(
      '- **Task** — Done\n  - did a thing\n    - deeper\n  - and another\n- Next task',
    );
    if (list.type !== 'list') throw new Error('expected a list');
    expect(list.items.map(inlineText)).toEqual(['Task — Done', 'Next task']);
    const sub = list.sublists?.[0];
    expect(sub?.items.map(inlineText)).toEqual(['did a thing', 'and another']);
    expect(sub?.sublists?.[0]?.items.map(inlineText)).toEqual(['deeper']);
    expect(list.sublists?.[1]).toBeNull();
  });

  it('leaves flat lists as they were', () => {
    const [list] = parseMarkdown('- a\n- b');
    expect(list).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
    });
  });
});
