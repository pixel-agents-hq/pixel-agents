import {
  TERMINAL_LINK_PROTOCOLS,
  TERMINAL_LINK_WINDOW_FEATURES,
  TERMINAL_URL_PATTERN,
} from '../constants.js';

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

/** The slice of xterm's buffer API urlAtCell reads. Structural, so this module
 *  stays DOM-free (xterm's own typings pull in DOM types). */
export interface TerminalBufferLike {
  getLine(y: number):
    | {
        readonly isWrapped: boolean;
        readonly length: number;
        getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
      }
    | undefined;
}

/**
 * The plain URL covering buffer cell (row, col), or null.
 *
 * Touch needs this because the terminal's touch handling prevents every
 * default (Safari would otherwise claim the gestures), which also suppresses
 * the synthesized click xterm's link providers activate on -- so a tap never
 * reached a link. Reads the whole LOGICAL line (soft-wrapped rows joined), as
 * the web-links addon does, so a URL wrapped across rows is found from either
 * half. OSC 8 hyperlinks are not covered: xterm exposes no public lookup of a
 * cell's link.
 */
export function urlAtCell(buffer: TerminalBufferLike, row: number, col: number): string | null {
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  let tapOffset = -1;
  for (let y = first; ; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (y === row && x === col) tapOffset = text.length;
      // A wide character's trailing cell has width 0 and no text of its own.
      if (cell && cell.getWidth() > 0) text += cell.getChars() || ' ';
    }
  }
  if (tapOffset < 0) return null;
  for (const match of text.matchAll(TERMINAL_URL_PATTERN)) {
    const start = match.index;
    if (tapOffset >= start && tapOffset < start + match[0].length) return match[0];
  }
  return null;
}
