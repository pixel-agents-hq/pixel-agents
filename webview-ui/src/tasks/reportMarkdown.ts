/**
 * A deliberately small markdown reader for the Manager's daily report
 * (docs/office/DESIGN.md, phase M): headings, bullet and numbered lists,
 * paragraphs, **bold**, *italic*, `code` and [links](https://...).
 *
 * It returns a tree of plain data, never HTML: the React side renders text
 * nodes as text (escaped), so markup in a report — the model writes it — can
 * never become live HTML. A link is a link only when its URL is http(s);
 * anything else (javascript:, data:, relative) stays as its text.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: Inline[][];
  /** Nested lists, by item index (null: that item has none). Absent when no item has one. */
  sublists?: Array<ListBlock | null>;
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | ListBlock;

/** A list line as read: its indentation decides what it nests under. */
interface ListLine {
  indent: number;
  ordered: boolean;
  text: string;
}

/** A run of list lines as a list, items indented past the first nesting under the item above. */
function buildList(lines: readonly ListLine[]): ListBlock {
  const base = lines[0].indent;
  const list: ListBlock = { type: 'list', ordered: lines[0].ordered, items: [] };
  const sublists: Array<ListBlock | null> = [];
  let i = 0;
  while (i < lines.length) {
    list.items.push(parseInline(lines[i].text));
    let j = i + 1;
    while (j < lines.length && lines[j].indent > base) j++;
    sublists.push(j > i + 1 ? buildList(lines.slice(i + 1, j)) : null);
    i = j;
  }
  if (sublists.some((s) => s !== null)) list.sublists = sublists;
  return list;
}

/** The URL itself when it is absolute http(s), else null. */
export function safeLinkHref(url: string): string | null {
  const trimmed = url.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Parse a report into blocks. Blank lines end paragraphs and lists. */
export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: ListLine[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(buildList(list));
      list = null;
    }
  };

  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (RULE.test(line)) {
      // A horizontal rule (---) just separates blocks.
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null;
      const indent = (raw.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length;
      // A top-level item of the other kind starts a new list.
      if (list && indent <= list[0].indent && list[0].ordered !== ordered) flushList();
      if (!list) list = [];
      list.push({ indent, ordered, text: item[1] });
      continue;
    }
    if (list) {
      // An indented line under an item continues it; anything else ends the list.
      if (/^\s+/.test(raw)) {
        list[list.length - 1].text += ` ${line.trim()}`;
        continue;
      }
      flushList();
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

const CODE = /^`([^`]+)`/;
// The URL may hold one level of balanced parentheses (wiki-style links).
const LINK = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/;
const BOLD = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const ITALIC = /^(\*|_)(?=\S)([^*_]*?\S)\1(?![*_])/;

/** Inline spans: code first (its content is literal), then links, bold, italic. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      out.push({ type: 'text', text: plain });
      plain = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    const code = rest.match(CODE);
    if (code) {
      flush();
      out.push({ type: 'code', text: code[1] });
      i += code[0].length;
      continue;
    }

    const link = rest.match(LINK);
    if (link) {
      const href = safeLinkHref(link[2]);
      flush();
      if (href) out.push({ type: 'link', href, children: parseInline(link[1]) });
      else out.push(...parseInline(link[1])); // not http(s): just its text
      i += link[0].length;
      continue;
    }

    const bold = rest.match(BOLD);
    if (bold) {
      flush();
      out.push({ type: 'bold', children: parseInline(bold[2]) });
      i += bold[0].length;
      continue;
    }

    // `_` only opens emphasis at a word start (snake_case stays as it is).
    const italic = rest.match(ITALIC);
    if (italic && (rest[0] === '*' || !/\w/.test(text[i - 1] ?? ''))) {
      flush();
      out.push({ type: 'italic', children: parseInline(italic[2]) });
      i += italic[0].length;
      continue;
    }

    plain += text[i];
    i++;
  }
  flush();
  return out;
}

/** The plain text of inline spans (link text, no URLs) — for titles and tests. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children)))
    .join('');
}
