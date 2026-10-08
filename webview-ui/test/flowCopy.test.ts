/**
 * Copy-flowing of Claude Code's soft-wrapped prose. A pure text transform
 * whose failure mode (silently flattening a user's indented YAML/JSON/code
 * on copy) no e2e would ever notice, so it is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { TERMINAL_COPY_WRAP_SLACK_COLS } from '../src/constants.js';
import { flowTerminalCopy } from '../src/terminal/flowCopy.js';

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

describe('flowTerminalCopy', () => {
  it('joins soft-wrapped prose back into one line', () => {
    const words = (
      "He'd stand in front of it for exactly as long as his wanderLimit allowed, " +
      'then turn around and walk back to his desk without a word'
    ).split(' ');
    const wrapped = softWrap('⏺ ', words, WRAP);
    expect(wrapped.split('\n').length).toBeGreaterThan(2);
    expect(flowTerminalCopy(wrapped, COLS)).toBe(`⏺ ${words.join(' ')}`);
  });

  it('trims trailing padding before joining', () => {
    const a = 'x'.repeat(WRAP - 4);
    expect(flowTerminalCopy(`${a}      \n  word`, COLS)).toBe(`${a} word`);
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
      expect(flowTerminalCopy(`${full}\n${structural}`, COLS)).toBe(`${full}\n${structural}`);
    }
  });

  it('keeps deeper indents (code blocks) untouched', () => {
    const full = 'x'.repeat(WRAP);
    expect(flowTerminalCopy(`${full}\n    return 1;`, COLS)).toBe(`${full}\n    return 1;`);
  });

  it('does not flatten short 2-space-indented structure (YAML, JSON, code)', () => {
    const yaml = 'foo:\n  bar: 1\n  baz:\n    - qux';
    expect(flowTerminalCopy(yaml, COLS)).toBe(yaml);
    const json = '{\n  "name": "pixel-agents",\n  "private": true\n}';
    expect(flowTerminalCopy(json, COLS)).toBe(json);
    const code = 'if (ready) {\n  start();\n}';
    expect(flowTerminalCopy(code, COLS)).toBe(code);
  });

  it('keeps a break when the next word would have fit on the row above', () => {
    // A row with room left for "fits" was ended deliberately, not wrapped.
    const row = 'x'.repeat(WRAP - 'fits'.length - 1);
    expect(flowTerminalCopy(`${row}\n  fits here`, COLS)).toBe(`${row}\n  fits here`);
    expect(flowTerminalCopy(`${row}x\n  fits here`, COLS)).toBe(`${row}x fits here`);
  });

  it('counts the start column of a selection that began mid-row', () => {
    const tail = 'x'.repeat(10);
    expect(flowTerminalCopy(`${tail}\n  more`, COLS)).toBe(`${tail}\n  more`);
    expect(flowTerminalCopy(`${tail}\n  more`, COLS, WRAP - 10)).toBe(`${tail} more`);
  });
});
