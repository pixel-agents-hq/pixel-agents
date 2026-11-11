import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

import { urlsOnLine } from './terminalLinks.js';

/**
 * The mouse side of plain-URL links: each URL on a hovered row, whole even
 * where it wraps (xterm's wrap or Claude Code's broken token, urlsOnLine),
 * so a click opens all of it — the same lookup a tap uses (urlAtCell).
 * `open` is terminalLinkOpener's, which allows http(s) only.
 */
export function terminalLinkProvider(
  term: Terminal,
  open: (event: MouseEvent, uri: string) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const row = y - 1; // xterm hands over 1-based rows
      const links: ILink[] = urlsOnLine(term.buffer.active, row, term.cols)
        .filter((u) => u.start.row <= row && row <= u.end.row)
        .map((u) => ({
          range: {
            start: { x: u.start.col + 1, y: u.start.row + 1 },
            end: { x: u.end.col + 1, y: u.end.row + 1 },
          },
          text: u.url,
          activate: (event, text) => open(event, text),
        }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
