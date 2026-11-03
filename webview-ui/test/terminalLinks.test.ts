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

import { TERMINAL_URL_PATTERN } from '../src/constants.js';
import type { TerminalBufferLike } from '../src/terminal/terminalLinks.js';
import { terminalLinkOpener, urlAtCell, urlsOnLine } from '../src/terminal/terminalLinks.js';

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

const COLS = 80;
const tapAt = (buffer: TerminalBufferLike, row: number, col: number) =>
  urlAtCell(buffer, row, col, COLS);

describe('urlAtCell', () => {
  const url = 'https://github.com/pixel-agents-hq/pixel-agents/pull/347';

  it('finds the URL under the tapped cell, and nothing beside it', () => {
    const buffer = bufferOf([{ text: `see ${url} now` }]);
    expect(tapAt(buffer, 0, 4)).toBe(url);
    expect(tapAt(buffer, 0, 4 + url.length - 1)).toBe(url);
    expect(tapAt(buffer, 0, 1)).toBeNull();
    expect(tapAt(buffer, 0, 4 + url.length + 1)).toBeNull();
  });

  it('drops trailing punctuation, as the click path does', () => {
    const buffer = bufferOf([{ text: `(${url}).` }]);
    expect(tapAt(buffer, 0, 5)).toBe(url);
  });

  it('joins soft-wrapped rows, so either half of a wrapped URL opens it', () => {
    const buffer = bufferOf([
      { text: `go ${url.slice(0, 20)}` },
      { text: `${url.slice(20)} ok`, wrapped: true },
    ]);
    expect(tapAt(buffer, 0, 5)).toBe(url);
    expect(tapAt(buffer, 1, 2)).toBe(url);
  });

  it('keeps cell positions right after a wide character', () => {
    const buffer = bufferOf([{ text: `中 ${url}`, wide: [0] }]);
    // Cells: 中, trailer, space, then the URL from cell 3.
    expect(tapAt(buffer, 0, 3)).toBe(url);
    expect(tapAt(buffer, 0, 2)).toBeNull();
  });

  it('only matches http(s) URLs', () => {
    expect(tapAt(bufferOf([{ text: 'javascript:alert(1)' }]), 0, 3)).toBeNull();
  });

  // Claude Code breaks a token longer than its row with a real newline and
  // carries on after its block's indent — no isWrapped for xterm to see.
  const NARROW = 30;
  const broken = (rows: string[]) => bufferOf(rows.map((text) => ({ text })));

  it('follows a URL Claude Code broke across rows, from any of them', () => {
    // '⎿  ' + 27 chars = 30 (full), then 5-space continuation rows.
    const first = `⎿  ${url.slice(0, 27)}`;
    const second = `     ${url.slice(27, 52)}`;
    const third = `     ${url.slice(52)}`;
    expect(first.length).toBe(NARROW);
    expect(second.length).toBe(NARROW);
    const buffer = broken([first, second, third, '', 'next']);
    for (const [row, col] of [
      [0, 5],
      [1, 10],
      [2, 6],
    ]) {
      expect(urlAtCell(buffer, row, col, NARROW)).toBe(url);
    }
    // The indent is not part of the link.
    expect(urlAtCell(buffer, 1, 2, NARROW)).toBeNull();
    expect(urlsOnLine(buffer, 1, NARROW)).toEqual([
      { url, start: { row: 0, col: 3 }, end: { row: 2, col: 5 + url.length - 53 } },
    ]);
  });

  it('keeps rows apart that only happen to touch', () => {
    // A row that ends short, or a short word that would have fit, is no break.
    const short = broken([`  ${url.slice(0, 20)}`, `  ${url.slice(20)}`]);
    expect(urlAtCell(short, 0, 4, NARROW)).toBe(url.slice(0, 20));
    const word = 'see the docs at https://a.io x';
    expect(word.length).toBe(NARROW);
    const fits = broken([word, '  then more']);
    expect(urlAtCell(fits, 0, 20, NARROW)).toBe('https://a.io');
  });
});

describe('TERMINAL_URL_PATTERN', () => {
  it('is not global, so a copy with a g flag appended still builds', () => {
    // A shared global regex would carry lastIndex between calls; callers
    // build their own global copy instead.
    expect(TERMINAL_URL_PATTERN.global).toBe(false);
    const rebuilt = new RegExp(
      TERMINAL_URL_PATTERN.source,
      (TERMINAL_URL_PATTERN.flags || '') + 'g',
    );
    expect('see https://example.com/a, then'.match(rebuilt)).toEqual(['https://example.com/a']);
  });
});
