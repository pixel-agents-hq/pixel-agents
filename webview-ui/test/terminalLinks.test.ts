/**
 * Terminal link activation: the scheme allowlist that stands between untrusted
 * terminal output (OSC 8 hyperlinks, printed URLs) and window.open, and the
 * touch-tap URL lookup that stands in for the click mobile taps never send.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * it pins a security invariant, not UI internals -- a `javascript:` link that
 * an e2e run would have to click (and then observe NOT executing) is far more
 * directly stated as "window.open was never called".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalBufferLike } from '../src/terminal/terminalLinks.js';
import { terminalLinkOpener, urlAtCell } from '../src/terminal/terminalLinks.js';

const open = vi.fn();
const openTerminalLink = terminalLinkOpener(open);
const event = {} as MouseEvent;

beforeEach(() => {
  open.mockReset();
});

describe('terminalLinkOpener', () => {
  it('opens http(s) links in a new tab with no opener and no referrer', () => {
    openTerminalLink(event, 'https://github.com/pixel-agents-hq/pixel-agents');
    openTerminalLink(event, 'http://localhost:5173/');
    expect(open.mock.calls).toEqual([
      ['https://github.com/pixel-agents-hq/pixel-agents', '_blank', 'noopener,noreferrer'],
      ['http://localhost:5173/', '_blank', 'noopener,noreferrer'],
    ]);
  });

  it('ignores every other scheme an OSC 8 link can carry', () => {
    for (const uri of [
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vscode://file/etc/passwd',
      'ssh://evil.example',
    ]) {
      openTerminalLink(event, uri);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores text that is not a URL at all', () => {
    openTerminalLink(event, 'not a url');
    expect(open).not.toHaveBeenCalled();
  });
});

/** A fake xterm buffer: one string per row, each char one cell; `wide` marks a
 *  cell followed by a width-0 trailer, as xterm stores a CJK character. */
function bufferOf(
  rows: Array<{ text: string; wrapped?: boolean; wide?: number[] }>,
): TerminalBufferLike {
  return {
    getLine: (y) => {
      const row = rows[y];
      if (!row) return undefined;
      const cells: Array<{ chars: string; width: number }> = [];
      [...row.text].forEach((ch, i) => {
        if (row.wide?.includes(i)) cells.push({ chars: ch, width: 2 }, { chars: '', width: 0 });
        else cells.push({ chars: ch, width: 1 });
      });
      return {
        isWrapped: row.wrapped ?? false,
        length: cells.length,
        getCell: (x) => {
          const c = cells[x];
          return c && { getChars: () => c.chars, getWidth: () => c.width };
        },
      };
    },
  };
}

describe('urlAtCell', () => {
  const url = 'https://github.com/pixel-agents-hq/pixel-agents/pull/347';

  it('finds the URL under the tapped cell, and nothing beside it', () => {
    const buffer = bufferOf([{ text: `see ${url} now` }]);
    expect(urlAtCell(buffer, 0, 4)).toBe(url);
    expect(urlAtCell(buffer, 0, 4 + url.length - 1)).toBe(url);
    expect(urlAtCell(buffer, 0, 1)).toBeNull();
    expect(urlAtCell(buffer, 0, 4 + url.length + 1)).toBeNull();
  });

  it('drops trailing punctuation, as the click path does', () => {
    const buffer = bufferOf([{ text: `(${url}).` }]);
    expect(urlAtCell(buffer, 0, 5)).toBe(url);
  });

  it('joins soft-wrapped rows, so either half of a wrapped URL opens it', () => {
    const buffer = bufferOf([
      { text: `go ${url.slice(0, 20)}` },
      { text: `${url.slice(20)} ok`, wrapped: true },
    ]);
    expect(urlAtCell(buffer, 0, 5)).toBe(url);
    expect(urlAtCell(buffer, 1, 2)).toBe(url);
  });

  it('keeps cell positions right after a wide character', () => {
    const buffer = bufferOf([{ text: `中 ${url}`, wide: [0] }]);
    // Cells: 中, trailer, space, then the URL from cell 3.
    expect(urlAtCell(buffer, 0, 3)).toBe(url);
    expect(urlAtCell(buffer, 0, 2)).toBeNull();
  });

  it('only matches http(s) URLs', () => {
    expect(urlAtCell(bufferOf([{ text: 'javascript:alert(1)' }]), 0, 3)).toBeNull();
  });
});
