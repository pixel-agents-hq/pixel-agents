/**
 * Copy-flowing of Claude Code's soft-wrapped prose. A pure text transform
 * whose failure mode (silently flattening a user's indented YAML/JSON/code
 * on copy) no e2e would ever notice, so it is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { TERMINAL_COPY_WRAP_SLACK_COLS } from '../src/constants.js';
import { terminalCopyText } from '../src/terminal/flowCopy.js';

const COLS = 50;
/** Widest row Claude Code fills before wrapping, per the slack constant. */
const WRAP = COLS - TERMINAL_COPY_WRAP_SLACK_COLS;

/** Word-wrap `words` the way Claude Code does: rows up to `width`, every
 *  row after the first indented two spaces. */
function softWrap(prefix: string, words: string[], width: number): string {
  const rows: string[] = [];
  let row = prefix;
  for (const word of words) {
    const sep = row.endsWith(' ') ? '' : ' ';
    if (row.length + sep.length + word.length > width) {
      rows.push(row);
      row = `  ${word}`;
    } else {
      row += sep + word;
    }
  }
  rows.push(row);
  return rows.join('\n');
}

describe("terminalCopyText 'text': re-flowing soft wraps", () => {
  it('joins soft-wrapped prose back into one line', () => {
    const words = (
      "He'd stand in front of it for exactly as long as his wanderLimit allowed, " +
      'then turn around and walk back to his desk without a word'
    ).split(' ');
    const wrapped = softWrap('⏺ ', words, WRAP);
    expect(wrapped.split('\n').length).toBeGreaterThan(2);
    expect(terminalCopyText(wrapped, 'text', COLS)).toBe(`⏺ ${words.join(' ')}`);
  });

  it('trims trailing padding before joining', () => {
    const a = 'x'.repeat(WRAP - 4);
    expect(terminalCopyText(`${a}      \n  word`, 'text', COLS)).toBe(`${a} word`);
  });

  it('keeps structural lines on their own row even after a full row', () => {
    const full = 'x'.repeat(WRAP);
    for (const structural of [
      '  ⎿  Read 12 lines',
      '  │ box drawing',
      '  - bullet',
      '  * bullet',
      '  • bullet',
      '  ☐ todo',
      '  ☒ done',
      '  > quote',
      '  # header',
      '  1. numbered',
      '  2) numbered',
    ]) {
      expect(terminalCopyText(`${full}\n${structural}`, 'text', COLS)).toBe(
        `${full}\n${structural}`,
      );
    }
  });

  it('keeps deeper indents (code blocks) untouched', () => {
    const full = 'x'.repeat(WRAP);
    expect(terminalCopyText(`${full}\n    return 1;`, 'text', COLS)).toBe(`${full}\n    return 1;`);
  });

  it('does not flatten short 2-space-indented structure (YAML, JSON, code)', () => {
    const yaml = 'foo:\n  bar: 1\n  baz:\n    - qux';
    expect(terminalCopyText(yaml, 'text', COLS)).toBe(yaml);
    const json = '{\n  "name": "pixel-agents",\n  "private": true\n}';
    expect(terminalCopyText(json, 'text', COLS)).toBe(json);
    const code = 'if (ready) {\n  start();\n}';
    expect(terminalCopyText(code, 'text', COLS)).toBe(code);
  });

  it('keeps a break when the next word would have fit on the row above', () => {
    // A row with room left for "fits" was ended deliberately, not wrapped.
    const row = 'x'.repeat(WRAP - 'fits'.length - 1);
    expect(terminalCopyText(`${row}\n  fits here`, 'text', COLS)).toBe(`${row}\n  fits here`);
    expect(terminalCopyText(`${row}x\n  fits here`, 'text', COLS)).toBe(`${row}x fits here`);
  });

  it('counts the start column of a selection that began mid-row', () => {
    const tail = 'x'.repeat(10);
    expect(terminalCopyText(`${tail}\n  more`, 'text', COLS)).toBe(`${tail}\n  more`);
    expect(terminalCopyText(`${tail}\n  more`, 'text', COLS, WRAP - 10)).toBe(`${tail} more`);
  });
});

describe('terminalCopyText: verbatim unless asked to re-flow', () => {
  // Both look exactly like a soft wrap to the heuristic: a row filled past
  // the wrap width, then a two-space-indented line whose first word would
  // not have fit — so re-flowing joins them.
  const yaml = `${'long_key_'.repeat(5).slice(0, WRAP)}:\n  enabled: true`;
  const code = `${'x'.repeat(WRAP - 1)}\n  return response.json();`;

  it('the default copy is verbatim: indented structure under a long row survives', () => {
    expect(terminalCopyText(yaml, 'verbatim', COLS)).toBe(yaml);
    expect(terminalCopyText(code, 'verbatim', COLS)).toBe(code);
  });

  it('the heuristic would have flattened them (why it is opt-in)', () => {
    expect(terminalCopyText(yaml, 'text', COLS)).not.toContain('\n');
    expect(terminalCopyText(code, 'text', COLS)).not.toContain('\n');
  });

  it('"Copy as text" re-flows soft-wrapped prose', () => {
    const words = 'the quick brown fox jumps over the lazy dog again and again'.split(' ');
    const wrapped = softWrap('So', [...words, ...words], WRAP);
    expect(wrapped).toContain('\n');
    expect(terminalCopyText(wrapped, 'text', COLS)).toBe(['So', ...words, ...words].join(' '));
  });

  it('"Copy as text" counts the start column of a mid-row selection', () => {
    expect(terminalCopyText('ab\n  cd', 'text', COLS, WRAP)).toBe('ab cd');
  });

  // Claude Code breaks a token longer than its row (a URL, a path) mid-word
  // and carries on after its block's indent: that break has a signature, so
  // EVERY copy — verbatim too — joins it back, with no space and no indent.
  const url = 'https://github.com/pixel-agents-hq/pixel-agents/pull/412/files#diff';
  const first = `⎿  see ${url.slice(0, COLS - 7)}`;
  const rest = url.slice(COLS - 7);
  const brokenUrl = `${first}\n     ${rest}\n  done`;

  it('joins a URL Claude Code broke across rows, even verbatim', () => {
    expect(first.length).toBe(COLS);
    expect(terminalCopyText(brokenUrl, 'verbatim', COLS)).toBe(`⎿  see ${url}\n  done`);
    expect(terminalCopyText(brokenUrl, 'text', COLS)).toBe(`⎿  see ${url}\n  done`);
    // Windows-style selections keep their own line breaks.
    expect(terminalCopyText(brokenUrl.replaceAll('\n', '\r\n'), 'verbatim', COLS)).toBe(
      `⎿  see ${url}\r\n  done`,
    );
  });

  it('a mid-row selection of it joins too', () => {
    const fromUrl = `${first.slice(7)}\n     ${rest}`;
    expect(terminalCopyText(fromUrl, 'verbatim', COLS, 7)).toBe(url);
  });

  it('a full row ending in a word that fit keeps its newline', () => {
    // Ends at the last column, but "next" would have fit on a fresh row: an
    // ordinary wrap or an intended break, not a broken token.
    const row = 'x'.repeat(COLS - 5) + ' word';
    expect(row.length).toBe(COLS);
    expect(terminalCopyText(`${row}\n  next`, 'verbatim', COLS)).toBe(`${row}\n  next`);
  });
});
