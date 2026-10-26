import {
  TERMINAL_LINK_PROTOCOLS,
  TERMINAL_LINK_WINDOW_FEATURES,
  TERMINAL_URL_PATTERN,
} from '../constants.js';
import { hardWrapIndent } from './hardWrap.js';
import type { CellPos } from './selectionMath.js';

/**
 * Open a link the terminal pane was clicked or tapped on -- the ONE activation
 * path for plain URLs (WebLinksAddon on click, urlAtCell on touch) and OSC 8
 * hyperlinks (Terminal linkHandler).
 *
 * Terminal output is untrusted: an agent that `cat`s a file or prints fetched
 * web content can emit an OSC 8 link whose visible text is innocent and whose
 * target is `javascript:`, `file:` or an OS protocol handler. xterm's built-in
 * OSC 8 activator opens any scheme into a same-origin popup after a generic
 * confirm(), so only http(s) is opened here, straight into a new tab with no
 * opener and no referrer (the page URL carries the server token). Anything
 * else is ignored.
 *
 * Takes `open` (window.open in the app) so this stays DOM-free for the Node
 * test runner.
 */
export function terminalLinkOpener(
  open: (url: string, target: string, features: string) => unknown,
): (event: unknown, uri: string) => void {
  return (_event, uri) => {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return;
    }
    if (!TERMINAL_LINK_PROTOCOLS.includes(url.protocol)) return;
    open(url.href, '_blank', TERMINAL_LINK_WINDOW_FEATURES);
  };
}

/** The slice of xterm's buffer API the link lookup reads. Structural, so this
 *  module stays DOM-free (xterm's own typings pull in DOM types). */
export interface TerminalBufferLike {
  getLine(y: number):
    | {
        readonly isWrapped: boolean;
        readonly length: number;
        getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
      }
    | undefined;
}

/** A plain URL on screen: its text and the cells it starts and ends on. */
export interface TerminalUrl {
  url: string;
  start: CellPos;
  end: CellPos;
}

/** One visual row as text, with the cell each character came from. */
interface RowText {
  text: string;
  cols: number[];
}

function rowCells(buffer: TerminalBufferLike, y: number): RowText {
  const line = buffer.getLine(y);
  let text = '';
  const cols: number[] = [];
  for (let x = 0; line && x < line.length; x++) {
    const cell = line.getCell(x);
    // A wide character's trailing cell has width 0 and no text of its own.
    if (!cell || cell.getWidth() === 0) continue;
    text += cell.getChars() || ' ';
    cols.push(x);
  }
  return { text: text.trimEnd(), cols };
}

/** Whether row `y + 1` carries on row `y`: xterm's own wrap, or Claude Code
 *  breaking a long token (hardWrap.ts). Returns the columns of `y + 1` to
 *  skip (its indent), or null. `row` reads a row's text (memoized by the
 *  caller: the walk asks for each row several times). */
function continuesFrom(
  buffer: TerminalBufferLike,
  row: (y: number) => RowText,
  y: number,
  cols: number,
): number | null {
  const next = buffer.getLine(y + 1);
  if (!next) return null;
  if (next.isWrapped) return 0;
  return hardWrapIndent(row(y).text, row(y + 1).text, cols);
}

/**
 * The line row `row` belongs to, joined across xterm's wraps AND Claude
 * Code's broken tokens, as text plus the cell of every character.
 */
function logicalLine(
  buffer: TerminalBufferLike,
  row: number,
  cols: number,
): { text: string; cells: CellPos[] } {
  const rows = new Map<number, RowText>();
  const rowAt = (y: number): RowText => {
    let r = rows.get(y);
    if (!r) {
      r = rowCells(buffer, y);
      rows.set(y, r);
    }
    return r;
  };
  let first = row;
  while (first > 0 && continuesFrom(buffer, rowAt, first - 1, cols) !== null) first--;
  let text = '';
  const cells: CellPos[] = [];
  for (let y = first, skip = 0; ;) {
    const r = rowAt(y);
    for (let i = skip; i < r.text.length; i++) {
      text += r.text[i];
      cells.push({ row: y, col: r.cols[i] });
    }
    const next = continuesFrom(buffer, rowAt, y, cols);
    if (next === null) break;
    // xterm's own wrap keeps the row's trailing spaces as text.
    if (next === 0) {
      const line = buffer.getLine(y)!;
      for (let x = (r.cols.at(-1) ?? -1) + 1; x < line.length; x++) {
        text += ' ';
        cells.push({ row: y, col: x });
      }
    }
    y++;
    skip = next;
  }
  return { text, cells };
}

/** Every plain URL in `text`, as indexes into it (first and last character). */
function matchUrls(text: string): Array<{ url: string; from: number; to: number }> {
  return [...text.matchAll(new RegExp(TERMINAL_URL_PATTERN.source, 'g'))].map((m) => ({
    url: m[0],
    from: m.index,
    to: m.index + m[0].length - 1,
  }));
}

/** Every plain URL on the line row `row` belongs to (wrapped either way). */
export function urlsOnLine(buffer: TerminalBufferLike, row: number, cols: number): TerminalUrl[] {
  const { text, cells } = logicalLine(buffer, row, cols);
  return matchUrls(text).map(({ url, from, to }) => ({ url, start: cells[from], end: cells[to] }));
}

/**
 * The plain URL covering buffer cell (row, col), or null.
 *
 * Touch needs this because the terminal's touch handling prevents every
 * default (Safari would otherwise claim the gestures), which also suppresses
 * the synthesized click xterm's link providers activate on -- so a tap never
 * reached a link. Reads the whole line (xterm's wraps and Claude Code's
 * broken tokens joined), so a URL wrapped across rows is found whole from
 * any of its rows. OSC 8 hyperlinks are not covered: xterm exposes no public
 * lookup of a cell's link.
 */
export function urlAtCell(
  buffer: TerminalBufferLike,
  row: number,
  col: number,
  cols: number,
): string | null {
  const { text, cells } = logicalLine(buffer, row, cols);
  // The tap counts only on a character of the line (not a continuation's indent).
  const tap = cells.findIndex((c) => c.row === row && c.col === col);
  if (tap < 0) return null;
  return matchUrls(text).find(({ from, to }) => tap >= from && tap <= to)?.url ?? null;
}
